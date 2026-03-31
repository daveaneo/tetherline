import type {
  ClientEvent,
  ServerEvent,
  SessionState,
  StateContext,
  Area,
  AreaWithContent,
  CommitDiff,
  Concern,
  HeatmapData,
  SessionSummary,
  ModeKey,
  EntryMode,
  UnderstandingState,
  SkillResult,
  SkillName,
} from '@interactive-reviewer/shared';
import { DEFAULT_MODES } from '@interactive-reviewer/shared';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import simpleGit from 'simple-git';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { GitAnalyzer } from '../git/analyzer.js';
import { computeHeatmap } from '../git/heatmap.js';
import { IntelligenceAnalyzer } from '../intelligence/analyzer.js';
import { buildProjectOverviewPrompt, PROJECT_OVERVIEW_TOOL, type ProjectOverviewResult } from '../intelligence/prompts/project-overview.js';
import { createSkillRegistry, IntentClassifier } from '../skills/index.js';
import type { SkillRegistry } from '../skills/index.js';
import { TourPlan } from './tour-plan.js';

export class SessionManager {
  private state: SessionState = { phase: 'IDLE' };
  private context: StateContext = {
    sessionId: '',
    totalAreas: 0,
    modes: { ...DEFAULT_MODES },
    concerns: [],
  };

  // In-memory data for the active session
  private areas: AreaWithContent[] = [];
  private heatmapData: HeatmapData | null = null;
  private previousSession: SessionSummary | null = null;
  private entryMode: EntryMode = 'updates';
  private projectOverview: ProjectOverviewResult | null = null;
  private activeRepoPath: string = '';
  private skillRegistry: SkillRegistry = createSkillRegistry();
  private intentClassifier: IntentClassifier | null = null;
  private activeAnalyzer: IntelligenceAnalyzer | null = null;
  private fileTree: string[] = [];
  private tourPlan: TourPlan | null = null;

  constructor(
    private db: Database,
    private config: AppConfig,
    private emit: (event: ServerEvent) => void,
  ) {}

  handleEvent(event: ClientEvent): void {
    switch (event.type) {
      case 'session:start':
        this.entryMode = event.payload.entryMode ?? 'updates';
        this.startSession(event.payload.repoPath, event.payload.sinceDays).catch(err => {
          this.emit({ type: 'error', payload: { code: 'START_FAILED', message: err.message ?? 'Failed to start session', recoverable: false } });
        });
        break;
      case 'session:resume':
        this.resumeSession(event.payload.sessionId).catch(err => {
          this.emit({ type: 'error', payload: { code: 'RESUME_FAILED', message: err.message ?? 'Failed to resume session', recoverable: false } });
        });
        break;
      case 'command:next':
      case 'command:previous':
      case 'command:dive_deeper':
      case 'command:skip':
      case 'command:pause':
      case 'command:resume':
        this.handleNavigation(event.type);
        break;
      case 'command:ask':
        this.handleQuestion(event.payload.question);
        break;
      case 'command:toggle_mode':
        this.handleModeToggle(event.payload.mode, event.payload.enabled);
        break;
      case 'command:export':
        this.handleExport(event.payload.format);
        break;
      case 'audio:segment_finished':
        this.handleSegmentFinished(event.payload.segmentId);
        break;
      case 'user:utterance':
        this.handleUtterance(event.payload.text).catch(err => {
          this.emit({ type: 'error', payload: { code: 'UTTERANCE_FAILED', message: err.message ?? 'Failed to handle utterance', recoverable: true } });
        });
        break;
    }
  }

  private async startSession(repoPath: string, sinceDays?: number) {
    try {
      const effectivePath = repoPath || this.config.repoPath;
      this.activeRepoPath = effectivePath;
      const repoName = path.basename(effectivePath);
      const sessionId = uuid();
      const now = new Date();
      const since = new Date(now);
      since.setDate(since.getDate() - (sinceDays ?? 7));

      // Update context
      this.context.sessionId = sessionId;

      // Create session record in DB
      this.db.getSessionRepo().createSession({
        id: sessionId,
        repoPath: effectivePath,
        repoName,
        startedAt: now.toISOString(),
        sinceDate: since.toISOString(),
        untilDate: now.toISOString(),
      });

      // Check for a previous session to determine greeting text
      const previousSessionRecord = this.db.getSessionRepo().getLastSessionForRepo(effectivePath);

      // Emit greeting immediately before analysis begins
      const isFirstVisit = !previousSessionRecord;
      const greetingText = isFirstVisit
        ? `Let me take a look at ${repoName} for the first time...`
        : `Welcome back to ${repoName}. Let me see what's changed...`;

      this.emit({
        type: 'narration:greeting',
        payload: { text: greetingText },
      });

      // Transition to ANALYZING
      this.setState({ phase: 'ANALYZING' });
      this.emit({
        type: 'analysis:started',
        payload: { sessionId },
      });

      // Run the git analysis pipeline (reading commits + parsing diffs)
      const gitAnalyzer = new GitAnalyzer(effectivePath);
      const { commits, areas: heuristicAreas } = await gitAnalyzer.analyze(since, now, (progress) => {
        this.emit({ type: 'analysis:progress', payload: progress });
      });

      // Handle zero commits
      if (commits.length === 0) {
        if (this.entryMode === 'updates') {
          // Nothing changed since last review — emit a friendly message and wrap up
          this.emit({
            type: 'narration:greeting',
            payload: { text: `Nothing's changed in ${repoName} since your last review. Check back later or try a full walkthrough to explore the architecture.` },
          });

          // Still compute heatmap and finish the session record
          const gitZero = simpleGit(effectivePath);
          const familiarityZero = this.db.getHeatmapRepo().getForRepo(effectivePath);
          this.heatmapData = await computeHeatmap(effectivePath, gitZero, familiarityZero);
          this.emit({ type: 'session:heatmap', payload: { heatmap: this.heatmapData } });

          this.db.getSessionRepo().updateSession(sessionId, { totalCommits: 0, totalAreas: 0 });
          this.emit({
            type: 'analysis:progress',
            payload: { phase: 'complete', progress: 1, message: 'No new commits found' },
          });
          this.emit({
            type: 'analysis:complete',
            payload: {
              summary: { id: sessionId, repoName, startedAt: now.toISOString(), totalCommits: 0, totalAreas: 0 },
              areas: [],
            },
          });
          this.setState({ phase: 'WRAP_UP' });
          return;
        }
        // Full walkthrough with zero commits: proceed with file-tree-only analysis below
      }

      // Detect languages from file extensions in the diffs
      const languages = this.detectLanguages(commits);

      // Get previous session summary (for "Previously on..." -- reuses lookup from above)
      const previousSummary = (previousSessionRecord && previousSessionRecord.id !== sessionId)
        ? previousSessionRecord.summary
        : undefined;

      // Determine whether to use AI-powered analysis
      const apiKey = this.config.anthropicApiKey;
      const useAI = !!apiKey && commits.length > 0;

      let areas: Area[];
      let concerns: Concern[] = [];

      if (useAI) {
        // ── AI-powered analysis ──────────────────────────────────────────
        const intelligence = new IntelligenceAnalyzer(apiKey!, {
          repoName,
          languages,
          sinceDate: since.toISOString().split('T')[0],
          untilDate: now.toISOString().split('T')[0],
          commitCount: commits.length,
          previousSessionSummary: previousSummary,
        });
        this.activeAnalyzer = intelligence;

        // Initialize the intent classifier for skill-based voice interactions
        const { ClaudeClient } = await import('../intelligence/claude-client.js');
        this.intentClassifier = new IntentClassifier(new ClaudeClient(apiKey!));

        // Step 1: Semantic clustering
        this.emit({
          type: 'analysis:progress',
          payload: { phase: 'clustering', progress: 0.5, message: 'AI is grouping commits into areas...' },
        });
        areas = await intelligence.clusterCommits(commits, sessionId);

        // Store areas in DB
        const areaRepo = this.db.getAreaRepo();
        for (const area of areas) {
          areaRepo.createArea(area);
          this.emit({ type: 'analysis:area_ready', payload: { area } });
        }

        // Step 2: Generate narratives + detect concerns + architecture in parallel
        this.emit({
          type: 'analysis:progress',
          payload: { phase: 'generating_narratives', progress: 0.6, message: 'Generating narratives and detecting concerns...' },
        });

        // Build AreaWithContent wrappers for narrative generation
        const areasWithContent: AreaWithContent[] = areas.map(a => ({
          ...a,
          narrationSegments: [],
          architectureNodes: [],
          architectureEdges: [],
          deepDiveGenerated: false,
          reviewed: false,
        }));

        // Get file tree for architecture diagram
        const git = simpleGit(effectivePath);
        const fileTreeRaw = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']).catch(() => '');
        const fileTree = fileTreeRaw.split('\n').filter(Boolean);
        this.fileTree = fileTree;

        // Run narrative generation for each area, concerns detection, and architecture in parallel
        const narrativePromises = areasWithContent.map(async (area, idx) => {
          const segments = await intelligence.generateNarrative(area, commits);
          const overview = segments.length > 0 ? segments[0].text : area.description;
          areaRepo.updateArea(area.id, {
            narrativeText: overview,
            narrationSegments: JSON.stringify(segments),
          });
          this.emit({
            type: 'analysis:progress',
            payload: {
              phase: 'generating_narratives',
              progress: 0.6 + (0.2 * (idx + 1) / areasWithContent.length),
              message: `Generated narrative for "${area.name}"`,
            },
          });
          return { areaId: area.id, segments };
        });

        const concernsPromise = (async () => {
          this.emit({
            type: 'analysis:progress',
            payload: { phase: 'detecting_concerns', progress: 0.7, message: 'Detecting concerns...' },
          });
          return intelligence.detectConcerns(commits, sessionId);
        })();

        const architecturePromise = (async () => {
          this.emit({
            type: 'analysis:progress',
            payload: { phase: 'generating_architecture', progress: 0.75, message: 'Generating architecture diagram...' },
          });
          return intelligence.generateArchitecture(fileTree, areas);
        })();

        const [narrativeResults, detectedConcerns, architecture] = await Promise.all([
          Promise.all(narrativePromises),
          concernsPromise,
          architecturePromise,
        ]);

        concerns = detectedConcerns;

        // Store architecture data on each area (shared diagram across areas)
        for (const area of areas) {
          areaRepo.updateArea(area.id, {
            architectureNodes: JSON.stringify(architecture.nodes),
            architectureEdges: JSON.stringify(architecture.edges),
          });
        }

        // Store concerns in DB
        this.storeConcerns(concerns);
        this.context.concerns = concerns;

        // Generate and store session summary for next time's "Previously on..."
        try {
          const sessionSummaryText = await intelligence.generateSessionSummary(areas, concerns);
          this.db.getSessionRepo().updateSession(sessionId, { summary: sessionSummaryText });
        } catch {
          // Non-critical — skip if summary generation fails
        }
      } else {
        // ── Heuristic fallback (no API key) ──────────────────────────────
        areas = heuristicAreas;

        // Store areas in DB
        const areaRepo = this.db.getAreaRepo();
        for (const area of areas) {
          area.sessionId = sessionId;
          areaRepo.createArea(area);
          this.emit({ type: 'analysis:area_ready', payload: { area } });
        }
      }

      // Update session with commit/area counts
      this.db.getSessionRepo().updateSession(sessionId, {
        totalCommits: commits.length,
        totalAreas: areas.length,
      });

      // Load areas back with full content schema (AreaWithContent)
      this.areas = this.db.getAreaRepo().getAreasForSession(sessionId);
      this.context.totalAreas = this.areas.length;

      // Build tour plan from discovered areas
      this.tourPlan = TourPlan.fromAreas(this.areas);

      // Compute heatmap
      const git = simpleGit(effectivePath);
      const familiarity = this.db.getHeatmapRepo().getForRepo(effectivePath);
      this.heatmapData = await computeHeatmap(effectivePath, git, familiarity);

      // Send heatmap to frontend
      this.emit({
        type: 'session:heatmap',
        payload: { heatmap: this.heatmapData },
      });

      // Emit final progress
      this.emit({
        type: 'analysis:progress',
        payload: { phase: 'complete', progress: 1, message: 'Analysis complete' },
      });

      // Build summary for the analysis:complete event
      const summary: SessionSummary = {
        id: sessionId,
        repoName,
        startedAt: now.toISOString(),
        totalCommits: commits.length,
        totalAreas: areas.length,
      };

      this.emit({
        type: 'analysis:complete',
        payload: { summary, areas: this.areas },
      });

      // Mark repo as reviewed if it's a known repo
      const knownRepo = this.db.getRepoRepo().getByPath(effectivePath);
      if (knownRepo) {
        this.db.getRepoRepo().markReviewed(knownRepo.id, sessionId);
        // Compute understanding percentage from heatmap
        if (this.heatmapData) {
          const total = this.heatmapData.entries.length;
          const understood = this.heatmapData.entries.filter(e => e.status === 'green').length;
          const pct = total > 0 ? Math.round((understood / total) * 100) : 0;
          this.db.getRepoRepo().updateUnderstanding(knownRepo.id, pct);
        }
      }

      // Branch based on entry mode
      if (this.entryMode === 'full_walkthrough') {
        // Full walkthrough: generate project overview first
        try {
          this.projectOverview = await this.generateProjectOverview(effectivePath, repoName, languages, commits.length);
        } catch {
          // Fallback if overview generation fails
          this.projectOverview = {
            overview: `This is ${repoName}. Let me walk you through the codebase.`,
            purpose: repoName,
            techStack: languages,
            keyAreas: this.areas.slice(0, 5).map(a => a.name),
          };
        }

        // Seed understanding items for the project layer
        this.seedUnderstandingItems(effectivePath, repoName, this.areas);

        this.setState({ phase: 'PROJECT_OVERVIEW' });
      } else {
        // Updates mode (default): existing flow
        // Check for a previous session ("Previously on...")
        if (previousSessionRecord && previousSessionRecord.id !== sessionId) {
          this.previousSession = {
            id: previousSessionRecord.id,
            repoName: previousSessionRecord.repoName,
            startedAt: previousSessionRecord.startedAt,
            totalCommits: previousSessionRecord.totalCommits,
            totalAreas: previousSessionRecord.totalAreas,
            summary: previousSessionRecord.summary,
          };

          this.setState({ phase: 'PREVIOUSLY_ON' });
          this.emit({
            type: 'session:recap',
            payload: {
              previousSession: this.previousSession,
              narrative: this.previousSession.summary
                ?? `Last session reviewed ${this.previousSession.totalAreas} areas with ${this.previousSession.totalCommits} commits.`,
            },
          });
        } else {
          // No previous session, skip straight to HEATMAP
          this.setState({ phase: 'HEATMAP' });
        }
      }
    } catch (err: any) {
      this.setState({ phase: 'ERROR', error: err.message ?? 'Analysis failed' });
      this.emit({
        type: 'error',
        payload: {
          code: 'ANALYSIS_FAILED',
          message: err.message ?? 'Analysis failed',
          recoverable: false,
        },
      });
    }
  }

  private async resumeSession(sessionId: string) {
    try {
      const session = this.db.getSessionRepo().getSession(sessionId);
      if (!session) {
        this.emit({
          type: 'error',
          payload: { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} not found`, recoverable: false },
        });
        return;
      }

      this.context.sessionId = sessionId;
      this.areas = this.db.getAreaRepo().getAreasForSession(sessionId);
      this.context.totalAreas = this.areas.length;

      // Restore state snapshot if available
      if (session.stateSnapshot) {
        try {
          this.state = JSON.parse(session.stateSnapshot);
        } catch {
          this.state = { phase: 'OVERVIEW' };
        }
      } else {
        this.state = { phase: 'OVERVIEW' };
      }

      // Recompute heatmap
      const git = simpleGit(session.repoPath);
      const familiarity = this.db.getHeatmapRepo().getForRepo(session.repoPath);
      this.heatmapData = await computeHeatmap(session.repoPath, git, familiarity);

      this.emit({
        type: 'session:state_changed',
        payload: { state: this.state, context: this.context },
      });
    } catch (err: any) {
      this.setState({ phase: 'ERROR', error: err.message ?? 'Resume failed' });
      this.emit({
        type: 'error',
        payload: {
          code: 'RESUME_FAILED',
          message: err.message ?? 'Resume failed',
          recoverable: false,
        },
      });
    }
  }

  private handleNavigation(command: string) {
    switch (command) {
      case 'command:next':
        this.navigateNext();
        break;
      case 'command:previous':
        this.navigatePrevious();
        break;
      case 'command:skip':
        this.navigateSkip();
        break;
      case 'command:pause':
        this.setState({ ...this.state, paused: true });
        break;
      case 'command:resume':
        this.setState({ ...this.state, paused: false });
        break;
      case 'command:dive_deeper':
        this.handleDiveDeeper();
        break;
    }
  }

  private navigateNext() {
    switch (this.state.phase) {
      case 'PREVIOUSLY_ON':
        this.setState({ phase: 'HEATMAP' });
        break;

      case 'HEATMAP':
        this.setState({ phase: 'OVERVIEW' });
        break;

      case 'OVERVIEW':
        if (this.areas.length > 0) {
          this.setState({ phase: 'AREA_WALKTHROUGH', areaIndex: 0, segmentIndex: 0 });
        } else {
          this.setState({ phase: 'WRAP_UP' });
        }
        break;

      case 'PROJECT_OVERVIEW':
        // Mark project-level understanding
        this.markPhaseUnderstood('project', this.activeRepoPath, this.activeRepoPath);
        this.setState({ phase: 'ARCHITECTURE_OVERVIEW' });
        break;

      case 'ARCHITECTURE_OVERVIEW':
        // Mark architecture-level understanding
        this.markPhaseUnderstood('architecture', this.activeRepoPath, 'architecture');
        if (this.areas.length > 0) {
          this.setState({ phase: 'COMPONENT_TOUR', areaIndex: 0, segmentIndex: 0 });
        } else {
          this.setState({ phase: 'WRAP_UP' });
        }
        break;

      case 'COMPONENT_TOUR': {
        const areaIndex = this.state.areaIndex ?? 0;
        const area = this.areas[areaIndex];
        const segmentIndex = this.state.segmentIndex ?? 0;

        if (area && segmentIndex < area.narrationSegments.length - 1) {
          this.setState({ phase: 'COMPONENT_TOUR', areaIndex, segmentIndex: segmentIndex + 1 });
        } else if (areaIndex < this.areas.length - 1) {
          // Mark component understood and move to next
          if (area) {
            this.markPhaseUnderstood('component', this.activeRepoPath, area.id);
            this.tourPlan?.markAreaCovered(area.id);
            this.emitTourProgress();
          }
          this.setState({ phase: 'AREA_TRANSITION', areaIndex: areaIndex + 1 });
        } else {
          // All components done
          if (area) {
            this.markPhaseUnderstood('component', this.activeRepoPath, area.id);
            this.tourPlan?.markAreaCovered(area.id);
            this.emitTourProgress();
          }
          this.setState({ phase: 'WRAP_UP' });
        }
        break;
      }

      case 'AREA_WALKTHROUGH': {
        const areaIndex = this.state.areaIndex ?? 0;
        const area = this.areas[areaIndex];
        const segmentIndex = this.state.segmentIndex ?? 0;

        if (area && segmentIndex < area.narrationSegments.length - 1) {
          // Advance to next segment within the area
          this.setState({ phase: 'AREA_WALKTHROUGH', areaIndex, segmentIndex: segmentIndex + 1 });
        } else if (areaIndex < this.areas.length - 1) {
          // Move to transition, then next area
          if (area) {
            this.tourPlan?.markAreaCovered(area.id);
            this.emitTourProgress();
          }
          this.setState({ phase: 'AREA_TRANSITION', areaIndex: areaIndex + 1 });
        } else {
          // All areas done
          if (area) {
            this.tourPlan?.markAreaCovered(area.id);
            this.emitTourProgress();
          }
          this.setState({ phase: 'WRAP_UP' });
        }
        break;
      }

      case 'AREA_TRANSITION': {
        const nextIndex = this.state.areaIndex ?? 0;
        const nextPhase = this.entryMode === 'full_walkthrough' ? 'COMPONENT_TOUR' : 'AREA_WALKTHROUGH';
        this.setState({ phase: nextPhase, areaIndex: nextIndex, segmentIndex: 0 });
        break;
      }

      case 'QA':
        // Return to wherever we came from
        this.setState({
          phase: this.state.returnToPhase ?? 'OVERVIEW',
          areaIndex: this.state.returnToAreaIndex,
          segmentIndex: this.state.returnToSegmentIndex,
        });
        break;

      case 'WRAP_UP':
        this.setState({ phase: 'COMPLETED' });
        if (this.context.sessionId) {
          this.db.getSessionRepo().updateSession(this.context.sessionId, {
            completedAt: new Date().toISOString(),
          });
        }
        break;

      default:
        break;
    }
  }

  private navigatePrevious() {
    switch (this.state.phase) {
      case 'HEATMAP':
        if (this.previousSession) {
          this.setState({ phase: 'PREVIOUSLY_ON' });
        }
        break;

      case 'OVERVIEW':
        this.setState({ phase: 'HEATMAP' });
        break;

      case 'PROJECT_OVERVIEW':
        // Can't go back from project overview (it's the first phase)
        break;

      case 'ARCHITECTURE_OVERVIEW':
        this.setState({ phase: 'PROJECT_OVERVIEW' });
        break;

      case 'COMPONENT_TOUR': {
        const areaIndex = this.state.areaIndex ?? 0;
        const segmentIndex = this.state.segmentIndex ?? 0;

        if (segmentIndex > 0) {
          this.setState({ phase: 'COMPONENT_TOUR', areaIndex, segmentIndex: segmentIndex - 1 });
        } else if (areaIndex > 0) {
          const prevArea = this.areas[areaIndex - 1];
          const lastSeg = Math.max(0, prevArea.narrationSegments.length - 1);
          this.setState({ phase: 'COMPONENT_TOUR', areaIndex: areaIndex - 1, segmentIndex: lastSeg });
        } else {
          this.setState({ phase: 'ARCHITECTURE_OVERVIEW' });
        }
        break;
      }

      case 'AREA_WALKTHROUGH': {
        const areaIndex = this.state.areaIndex ?? 0;
        const segmentIndex = this.state.segmentIndex ?? 0;

        if (segmentIndex > 0) {
          this.setState({ phase: 'AREA_WALKTHROUGH', areaIndex, segmentIndex: segmentIndex - 1 });
        } else if (areaIndex > 0) {
          // Go back to previous area's last segment
          const prevArea = this.areas[areaIndex - 1];
          const lastSeg = Math.max(0, prevArea.narrationSegments.length - 1);
          this.setState({ phase: 'AREA_WALKTHROUGH', areaIndex: areaIndex - 1, segmentIndex: lastSeg });
        } else {
          this.setState({ phase: 'OVERVIEW' });
        }
        break;
      }

      case 'AREA_TRANSITION': {
        const areaIndex = this.state.areaIndex ?? 0;
        const walkPhase = this.entryMode === 'full_walkthrough' ? 'COMPONENT_TOUR' : 'AREA_WALKTHROUGH';
        if (areaIndex > 0) {
          const prevArea = this.areas[areaIndex - 1];
          const lastSeg = Math.max(0, prevArea.narrationSegments.length - 1);
          this.setState({ phase: walkPhase, areaIndex: areaIndex - 1, segmentIndex: lastSeg });
        } else {
          this.setState({ phase: this.entryMode === 'full_walkthrough' ? 'ARCHITECTURE_OVERVIEW' : 'OVERVIEW' });
        }
        break;
      }

      case 'WRAP_UP': {
        const lastAreaIndex = this.areas.length - 1;
        const walkPhase = this.entryMode === 'full_walkthrough' ? 'COMPONENT_TOUR' : 'AREA_WALKTHROUGH';
        if (lastAreaIndex >= 0) {
          const lastArea = this.areas[lastAreaIndex];
          const lastSeg = Math.max(0, lastArea.narrationSegments.length - 1);
          this.setState({ phase: walkPhase, areaIndex: lastAreaIndex, segmentIndex: lastSeg });
        } else {
          this.setState({ phase: this.entryMode === 'full_walkthrough' ? 'ARCHITECTURE_OVERVIEW' : 'OVERVIEW' });
        }
        break;
      }

      default:
        break;
    }
  }

  private navigateSkip() {
    // Skip current area entirely and move to next
    if (this.state.phase === 'AREA_WALKTHROUGH' || this.state.phase === 'AREA_TRANSITION' || this.state.phase === 'COMPONENT_TOUR') {
      const areaIndex = this.state.areaIndex ?? 0;
      if (areaIndex < this.areas.length - 1) {
        this.setState({ phase: 'AREA_TRANSITION', areaIndex: areaIndex + 1 });
      } else {
        this.setState({ phase: 'WRAP_UP' });
      }
    }
  }

  private handleDiveDeeper() {
    if (this.state.phase === 'AREA_WALKTHROUGH' || this.state.phase === 'COMPONENT_TOUR') {
      this.setState({ ...this.state, deepDive: true });
    }
  }

  private handleQuestion(question: string) {
    // Save current location so we can return
    if (this.state.phase !== 'QA') {
      this.setState({
        phase: 'QA',
        returnToPhase: this.state.phase,
        returnToAreaIndex: this.state.areaIndex,
        returnToSegmentIndex: this.state.segmentIndex,
      });
    }
    // TODO: Wire up LLM Q&A -- for now just echo that we received the question
    this.emit({
      type: 'qa:answer_chunk',
      payload: { text: `Q&A not yet implemented. You asked: "${question}"`, done: true },
    });
  }

  private handleModeToggle(mode: string, enabled: boolean) {
    const key = mode as ModeKey;
    if (key in this.context.modes) {
      this.context.modes[key] = enabled;
      this.emit({
        type: 'session:state_changed',
        payload: { state: this.state, context: this.context },
      });
    }
  }

  private handleExport(format: 'slides' | 'markdown') {
    // TODO: Implement export
    this.emit({
      type: 'export:generating',
      payload: { format, progress: 0 },
    });
  }

  private handleSegmentFinished(segmentId: string) {
    // Auto-advance to next segment when narration finishes
    if ((this.state.phase === 'AREA_WALKTHROUGH' || this.state.phase === 'COMPONENT_TOUR') && !this.state.paused) {
      this.navigateNext();
    }
  }

  private async handleUtterance(text: string): Promise<void> {
    // If no intent classifier available, fall back to treating it as a question
    if (!this.intentClassifier) {
      this.handleQuestion(text);
      return;
    }

    // Build context string for the classifier
    const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
    const contextStr = `Phase: ${this.state.phase}. Area: ${currentArea?.name ?? 'none'}. Areas: ${this.areas.map(a => a.name).join(', ')}.`;

    const classification = await this.intentClassifier.classify(text, contextStr);

    // Handle navigation commands
    if (classification.skillName === 'navigation' && classification.navigationCommand) {
      // Handle resume_tour specially — pop deviation and restore position
      if (classification.navigationCommand === 'resume_tour') {
        this.resumeTour();
        return;
      }

      const navMap: Record<string, string> = {
        next: 'command:next',
        previous: 'command:previous',
        skip: 'command:skip',
        pause: 'command:pause',
        resume: 'command:resume',
        dive_deeper: 'command:dive_deeper',
        zoom_out: 'command:previous',
      };
      const eventType = navMap[classification.navigationCommand];
      if (eventType) {
        this.handleNavigation(eventType);
      }
      return;
    }

    // Low confidence -- ask for clarification
    if (classification.confidence < 0.7) {
      this.emit({
        type: 'skill:clarify',
        payload: {
          message: `I'm not sure what you'd like. Could you rephrase? I think you might want to:`,
          options: [
            `Explain ${classification.params.target ?? 'this'}`,
            `Visualize the architecture`,
            `Compare the changes`,
            `Summarize the current area`,
          ],
        },
      });
      return;
    }

    // Execute the skill -- requires an active analyzer
    if (!this.activeAnalyzer) {
      this.handleQuestion(text);
      return;
    }

    await this.executeSkillWithDeviation(classification.skillName as SkillName, classification.params, currentArea);
  }

  private async executeSkillWithDeviation(
    skillName: SkillName,
    params: Record<string, string>,
    currentArea?: AreaWithContent,
  ): Promise<void> {
    // If not already in a deviation, push one
    if (this.tourPlan && !this.tourPlan.isInDeviation()) {
      this.tourPlan.pushDeviation(
        this.state.phase,
        this.state.areaIndex,
        this.state.segmentIndex,
      );
    }

    try {
      const result = await this.skillRegistry.execute(
        skillName,
        {
          currentArea,
          currentFile: currentArea?.affectedFiles?.[0],
          zoomLevel: 0,
          repoPath: this.activeRepoPath,
          fileTree: this.fileTree,
          areas: this.areas,
          analyzer: this.activeAnalyzer!,
        },
        params,
      );

      this.emit({ type: 'skill:result', payload: { result } });

      // After skill completes, check in (once per deviation)
      if (this.tourPlan?.isInDeviation() && !this.tourPlan.hasCheckedIn()) {
        this.tourPlan.markDeviationCheckedIn();
        // Emit a gentle nudge so the user knows how to get back
        this.emit({
          type: 'narration:greeting',
          payload: { text: 'Take your time exploring. Say "back to the tour" whenever you\'re ready to continue.' },
        });
      }
    } catch (err: any) {
      this.emit({
        type: 'error',
        payload: { code: 'SKILL_FAILED', message: err.message ?? 'Skill execution failed', recoverable: true },
      });
    }
  }

  private resumeTour(): void {
    if (!this.tourPlan) return;

    // Get the resume message before popping (it reads the current deviation)
    const resumeMessage = this.tourPlan.getResumeMessage();
    const deviation = this.tourPlan.popDeviation();
    if (!deviation) return;

    // Narrate the resume
    this.emit({ type: 'narration:greeting', payload: { text: resumeMessage } });

    // Return to the saved position
    this.setState({
      phase: deviation.returnToPhase as SessionState['phase'],
      areaIndex: deviation.returnToAreaIndex,
      segmentIndex: deviation.returnToSegmentIndex,
    });
  }

  private emitTourProgress(): void {
    if (!this.tourPlan) return;
    const progress = this.tourPlan.getProgress();
    this.emit({ type: 'session:tour_progress', payload: progress });
  }

  private setState(state: SessionState) {
    this.state = state;
    if (state.phase === 'AREA_WALKTHROUGH' || state.phase === 'COMPONENT_TOUR') {
      const areaIndex = state.areaIndex ?? 0;
      this.context.currentAreaSegments = this.areas[areaIndex]?.narrationSegments?.length ?? 0;
    }
    this.emit({
      type: 'session:state_changed',
      payload: { state: this.state, context: this.context },
    });
  }

  /** Expose areas for REST endpoints */
  getAreas(): AreaWithContent[] {
    return this.areas;
  }

  /** Expose heatmap for REST endpoints */
  getHeatmapData(): HeatmapData | null {
    return this.heatmapData;
  }

  /** Detect programming languages from file extensions in the commit diffs. */
  private detectLanguages(diffs: CommitDiff[]): string[] {
    const extMap: Record<string, string> = {
      '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
      '.py': 'Python', '.rs': 'Rust', '.go': 'Go', '.java': 'Java', '.kt': 'Kotlin',
      '.rb': 'Ruby', '.php': 'PHP', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++',
      '.cs': 'C#', '.swift': 'Swift', '.scala': 'Scala', '.vue': 'Vue',
      '.svelte': 'Svelte', '.css': 'CSS', '.scss': 'SCSS', '.html': 'HTML',
      '.sql': 'SQL', '.sh': 'Shell', '.yml': 'YAML', '.yaml': 'YAML',
      '.json': 'JSON', '.md': 'Markdown', '.toml': 'TOML',
    };

    const langCounts = new Map<string, number>();
    for (const diff of diffs) {
      for (const fd of diff.fileDiffs) {
        const ext = path.extname(fd.path).toLowerCase();
        const lang = extMap[ext];
        if (lang) {
          langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
        }
      }
    }

    // Return languages sorted by frequency, top 5
    return [...langCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([lang]) => lang);
  }

  /** Generate a project overview using Claude. */
  private async generateProjectOverview(
    repoPath: string,
    repoName: string,
    languages: string[],
    totalCommits: number,
  ): Promise<ProjectOverviewResult> {
    // Read README.md
    let readmeContent: string | undefined;
    try {
      readmeContent = fs.readFileSync(path.join(repoPath, 'README.md'), 'utf-8');
    } catch {
      // No README
    }

    // Read package.json
    let packageJsonContent: string | undefined;
    try {
      packageJsonContent = fs.readFileSync(path.join(repoPath, 'package.json'), 'utf-8');
    } catch {
      // No package.json
    }

    // Get file tree
    const git = simpleGit(repoPath);
    const fileTreeRaw = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']).catch(() => '');
    const fileTree = fileTreeRaw.split('\n').filter(Boolean);

    const apiKey = this.config.anthropicApiKey;
    if (!apiKey) {
      return {
        overview: `This is ${repoName}. Let me walk you through the codebase.`,
        purpose: repoName,
        techStack: languages,
        keyAreas: [],
      };
    }

    const intelligence = new IntelligenceAnalyzer(apiKey, {
      repoName,
      languages,
      sinceDate: '',
      untilDate: '',
      commitCount: totalCommits,
    });

    const prompt = buildProjectOverviewPrompt({
      repoName,
      fileTree,
      readmeContent,
      packageJsonContent,
      languages,
      totalFiles: fileTree.length,
      totalCommits,
    });

    const result = await intelligence.structuredCallDirect<ProjectOverviewResult>({
      prompt,
      toolName: PROJECT_OVERVIEW_TOOL.name,
      toolDescription: PROJECT_OVERVIEW_TOOL.description,
      inputSchema: PROJECT_OVERVIEW_TOOL.inputSchema,
    });

    return result;
  }

  /** Seed understanding items for a repo so we can track progress across layers. */
  private seedUnderstandingItems(repoPath: string, repoName: string, areas: AreaWithContent[]): void {
    const repo = this.db.getUnderstandingRepo();

    // Project layer: single item
    repo.upsertItem({
      repoPath,
      layer: 'project',
      itemId: repoPath,
      itemName: repoName,
      status: 'not_started',
    });

    // Architecture layer: single item
    repo.upsertItem({
      repoPath,
      layer: 'architecture',
      itemId: 'architecture',
      itemName: 'Architecture Overview',
      status: 'not_started',
    });

    // Component layer: one per area
    for (const area of areas) {
      repo.upsertItem({
        repoPath,
        layer: 'component',
        itemId: area.id,
        itemName: area.name,
        status: 'not_started',
      });
    }
  }

  /** Mark a phase's understanding item as understood and emit the updated state. */
  private markPhaseUnderstood(layer: 'project' | 'architecture' | 'component', repoPath: string, itemId: string): void {
    const repo = this.db.getUnderstandingRepo();
    repo.markUnderstood(repoPath, layer, itemId);
    this.emitUnderstandingUpdate(repoPath);
  }

  /** Emit the current understanding state to the client. */
  private emitUnderstandingUpdate(repoPath: string): void {
    const understanding = this.db.getUnderstandingRepo().getState(repoPath);
    this.emit({
      type: 'session:understanding',
      payload: { understanding },
    });
  }

  /** Expose the project overview for REST endpoints or frontend. */
  getProjectOverview(): ProjectOverviewResult | null {
    return this.projectOverview;
  }

  /** Store concerns in the database. */
  private storeConcerns(concerns: Concern[]): void {
    const db = this.db.getRawDb();
    const stmt = db.prepare(`
      INSERT INTO concerns (id, session_id, area_id, severity, category, title, description, affected_files, commit_hashes, code_references, acknowledged)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const c of concerns) {
      stmt.run(
        c.id, c.sessionId, c.areaId ?? null, c.severity, c.category,
        c.title, c.description,
        JSON.stringify(c.affectedFiles), JSON.stringify(c.commitHashes),
        JSON.stringify(c.codeReferences), c.acknowledged ? 1 : 0,
      );
    }
  }

  cleanup() {
    // Persist current state if active session
    if (this.context.sessionId && this.state.phase !== 'IDLE') {
      this.db.getSessionRepo().updateSession(this.context.sessionId, {
        stateSnapshot: JSON.stringify(this.state),
      });
    }
  }
}
