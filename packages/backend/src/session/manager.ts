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
  private detectedLanguages: string[] = [];
  private proposalSuggestedOrder: string[] = [];

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

      // Detect staleness from previous session before analysis begins
      await this.detectStaleness(effectivePath);

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
          // Nothing changed since last review — offer to switch to full walkthrough
          this.emit({
            type: 'narration:greeting',
            payload: { text: `Nothing's changed in ${repoName} since your last review. Want to do a full walkthrough instead?` },
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

          // Transition to PROPOSAL so the user can choose to do a full walkthrough
          this.emit({
            type: 'session:proposal',
            payload: {
              message: `No new commits since your last review. You can do a full walkthrough to explore the architecture, or wrap up.`,
              suggestedOrder: [],
              areas: [],
            },
          });
          this.setState({ phase: 'PROPOSAL' });
          return;
        }
        // Full walkthrough with zero commits: proceed with file-tree-only analysis below
      }

      // Detect languages from file extensions in the diffs
      const languages = this.detectLanguages(commits);
      this.detectedLanguages = languages;

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

      // Generate proposal and transition to PROPOSAL phase for both entry modes
      this.proposalSuggestedOrder = this.areas.map(a => a.id);
      const proposalAreas = this.areas.map(a => ({
        id: a.id, name: a.name, significance: a.significance,
      }));

      let proposalMessage: string;
      if (this.activeAnalyzer) {
        try {
          proposalMessage = await this.activeAnalyzer.generateProposal(
            areas, this.entryMode, languages,
          );
        } catch {
          proposalMessage = this.buildFallbackProposal(languages);
        }
      } else {
        proposalMessage = this.buildFallbackProposal(languages);
      }

      // Store previous session info for updates mode (needed after proposal)
      if (this.entryMode === 'updates'
        && previousSessionRecord
        && previousSessionRecord.id !== sessionId
      ) {
        this.previousSession = {
          id: previousSessionRecord.id,
          repoName: previousSessionRecord.repoName,
          startedAt: previousSessionRecord.startedAt,
          totalCommits: previousSessionRecord.totalCommits,
          totalAreas: previousSessionRecord.totalAreas,
          summary: previousSessionRecord.summary,
        };
      }

      // For full walkthrough, generate project overview (used after proposal)
      if (this.entryMode === 'full_walkthrough') {
        try {
          this.projectOverview = await this.generateProjectOverview(
            effectivePath, repoName, languages, commits.length,
          );
        } catch {
          this.projectOverview = {
            overview: `This is ${repoName}. Let me walk you through the codebase.`,
            purpose: repoName,
            techStack: languages,
            keyAreas: this.areas.slice(0, 5).map(a => a.name),
          };
        }
        this.seedUnderstandingItems(effectivePath, repoName, this.areas);
      }

      this.emit({
        type: 'session:proposal',
        payload: {
          message: proposalMessage,
          suggestedOrder: this.proposalSuggestedOrder,
          areas: proposalAreas,
        },
      });
      this.setState({ phase: 'PROPOSAL' });
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
      case 'PROPOSAL':
        // User accepted the proposal — proceed into the tour
        this.acceptProposal();
        break;

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
      case 'PROPOSAL':
        // Can't go back from proposal (it's the first interactive phase)
        break;

      case 'PREVIOUSLY_ON':
        this.setState({ phase: 'PROPOSAL' });
        break;

      case 'HEATMAP':
        if (this.previousSession) {
          this.setState({ phase: 'PREVIOUSLY_ON' });
        } else {
          this.setState({ phase: 'PROPOSAL' });
        }
        break;

      case 'OVERVIEW':
        this.setState({ phase: 'HEATMAP' });
        break;

      case 'PROJECT_OVERVIEW':
        this.setState({ phase: 'PROPOSAL' });
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
    // From PROPOSAL, skip straight to WRAP_UP
    if (this.state.phase === 'PROPOSAL') {
      this.setState({ phase: 'WRAP_UP' });
      return;
    }
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

  private async handleQuestion(question: string) {
    // Save return state
    if (this.state.phase !== 'QA') {
      this.setState({
        phase: 'QA',
        returnToPhase: this.state.phase,
        returnToAreaIndex: this.state.areaIndex,
        returnToSegmentIndex: this.state.segmentIndex,
      });
    }

    // Try to answer with the intelligence analyzer
    if (this.activeAnalyzer) {
      try {
        const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
        const context = `Current area: ${currentArea?.name ?? 'none'}. ${currentArea?.description ?? ''}`;
        const answer = await this.activeAnalyzer.answerQuestion(question, context);
        this.emit({ type: 'qa:answer_chunk', payload: { text: answer, done: true } });
        return;
      } catch {
        // Fall through to fallback
      }
    }

    this.emit({
      type: 'qa:answer_chunk',
      payload: { text: `I can't answer questions without an Anthropic API key configured. Try adding ANTHROPIC_API_KEY to your .env file.`, done: true },
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

  private async handleExport(format: 'slides' | 'markdown') {
    this.setState({ phase: 'EXPORTING', exportFormat: format });

    try {
      const session = this.db.getSessionRepo().getSession(this.context.sessionId);
      if (!session) throw new Error('Session not found');

      const areas = this.db.getAreaRepo().getAreasForSession(this.context.sessionId);

      // Load concerns
      const concernRows = this.db.getRawDb().prepare(
        'SELECT * FROM concerns WHERE session_id = ?'
      ).all(this.context.sessionId) as any[];
      const concerns: Concern[] = concernRows.map((r: any) => ({
        id: r.id, sessionId: r.session_id, areaId: r.area_id,
        severity: r.severity, category: r.category, title: r.title,
        description: r.description, affectedFiles: JSON.parse(r.affected_files || '[]'),
        commitHashes: JSON.parse(r.commit_hashes || '[]'), codeReferences: JSON.parse(r.code_references || '[]'),
        acknowledged: !!r.acknowledged,
      }));

      const exportsDir = path.join(this.config.dataDir, 'exports');
      fs.mkdirSync(exportsDir, { recursive: true });

      let filename: string;
      let content: string;

      if (format === 'slides') {
        const { generateRevealSlides } = await import('../export/reveal-generator.js');
        content = generateRevealSlides(session, areas, concerns);
        filename = `review-${session.repoName}-${Date.now()}.html`;
      } else {
        const { generateMarkdownDigest } = await import('../export/markdown-generator.js');
        content = generateMarkdownDigest(session, areas, concerns);
        filename = `review-${session.repoName}-${Date.now()}.md`;
      }

      fs.writeFileSync(path.join(exportsDir, filename), content);

      this.emit({
        type: 'export:ready',
        payload: { format, downloadUrl: `/api/export/download/${filename}` },
      });

      this.setState({ phase: 'WRAP_UP' });
    } catch (err: any) {
      this.emit({
        type: 'error',
        payload: { code: 'EXPORT_FAILED', message: err.message, recoverable: true },
      });
      this.setState({ phase: 'WRAP_UP' });
    }
  }

  private handleSegmentFinished(segmentId: string) {
    // Auto-advance to next segment when narration finishes
    if ((this.state.phase === 'AREA_WALKTHROUGH' || this.state.phase === 'COMPONENT_TOUR') && !this.state.paused) {
      this.navigateNext();
    }
  }

  private async handleUtterance(text: string): Promise<void> {
    // During PROPOSAL phase, handle utterances with proposal-specific logic
    if (this.state.phase === 'PROPOSAL') {
      if (this.handleProposalUtterance(text)) return;
      // If not recognized as a proposal response, accept and proceed
      this.acceptProposal();
      return;
    }

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

      // Persist understanding updates from skill execution (e.g., explain/teach/critique)
      if (result.understandingUpdates) {
        const effectivePath = this.activeRepoPath ?? this.config.repoPath;
        for (const update of result.understandingUpdates) {
          this.db.getUnderstandingRepo().markUnderstood(effectivePath, update.layer as any, update.itemId);
        }
        this.emitUnderstandingUpdate(effectivePath);
      }

      // Persist annotations to the database
      if (result.skillName === 'annotate') {
        const rawDb = this.db.getRawDb();
        rawDb.prepare(`
          INSERT INTO annotations (id, repo_path, file_path, content, session_id, created_at)
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `).run(
          uuid(),
          this.activeRepoPath ?? this.config.repoPath,
          (result.visualPayload.file as string) ?? null,
          (result.visualPayload.note as string) ?? result.narration,
          this.context.sessionId,
        );
      }

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

  /** Accept the proposal and transition to the first tour phase. */
  private acceptProposal(): void {
    if (this.entryMode === 'full_walkthrough') {
      this.setState({ phase: 'PROJECT_OVERVIEW' });
    } else {
      // Updates mode: go through PREVIOUSLY_ON or straight to HEATMAP
      if (this.previousSession) {
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
        this.setState({ phase: 'HEATMAP' });
      }
    }
  }

  /** Build a fallback proposal message when AI generation is unavailable. */
  private buildFallbackProposal(languages: string[]): string {
    if (this.entryMode === 'full_walkthrough') {
      return `This is a ${languages.slice(0, 2).join(' and ') || ''} project with ${this.areas.length} key areas. I'd start with the big picture and work down into the components. Sound good, or is there something specific you want to see first?`;
    }
    return `I found ${this.areas.length} area${this.areas.length !== 1 ? 's' : ''} of change. The biggest is ${this.areas[0]?.name ?? 'unknown'}. I'd suggest starting there. Want to go in that order, or would you prefer something different?`;
  }

  /** Handle user utterance during PROPOSAL phase. Returns true if handled. */
  private handleProposalUtterance(text: string): boolean {
    const lower = text.toLowerCase().trim();

    // "yes" / "sounds good" / "let's go" → accept
    if (/^(yes|yeah|yep|sure|sounds? good|let'?s go|ok|okay|go ahead|start|begin|looks? good)/.test(lower)) {
      this.acceptProposal();
      return true;
    }

    // "just the highlights" → set condensed flag and accept
    if (/highlight|brief|quick|short|condensed|summary only|skim/.test(lower)) {
      // Filter to major/minor areas only when condensed
      const filtered = this.areas.filter(a => a.significance === 'major' || a.significance === 'minor');
      if (filtered.length > 0) {
        this.areas = filtered;
      }
      this.context.totalAreas = this.areas.length;
      this.tourPlan = TourPlan.fromAreas(this.areas);
      this.setState({ ...this.state, condensed: true });
      this.acceptProposal();
      return true;
    }

    // "focus on [X]" → filter to matching area and accept
    const focusMatch = lower.match(/focus (?:on )?(.+)/);
    if (focusMatch) {
      const target = focusMatch[1];
      const matching = this.areas.filter(a =>
        a.name.toLowerCase().includes(target) ||
        a.description.toLowerCase().includes(target),
      );
      if (matching.length > 0) {
        this.areas = matching;
        this.context.totalAreas = this.areas.length;
        this.tourPlan = TourPlan.fromAreas(this.areas);
      }
      this.acceptProposal();
      return true;
    }

    // "skip" → go to wrap up
    if (/^skip/.test(lower)) {
      this.setState({ phase: 'WRAP_UP' });
      return true;
    }

    // Check if user named a specific area → reorder to start there
    const matchedArea = this.areas.find(a =>
      lower.includes(a.name.toLowerCase()),
    );
    if (matchedArea) {
      const reordered = [matchedArea, ...this.areas.filter(a => a.id !== matchedArea.id)];
      this.areas = reordered;
      this.proposalSuggestedOrder = reordered.map(a => a.id);
      this.tourPlan = TourPlan.fromAreas(this.areas);
      this.context.totalAreas = this.areas.length;
      this.acceptProposal();
      return true;
    }

    return false;
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

    // File layer: one per affected file per area
    for (const area of areas) {
      for (const filePath of area.affectedFiles) {
        repo.upsertItem({
          repoPath,
          layer: 'file',
          itemId: `file-${filePath}`,
          itemName: filePath,
          parentId: `component-${area.id}`,
          status: 'not_started',
        });
      }
    }
  }

  /** Mark a phase's understanding item as understood and emit the updated state. */
  private markPhaseUnderstood(layer: 'project' | 'architecture' | 'component', repoPath: string, itemId: string): void {
    const repo = this.db.getUnderstandingRepo();
    repo.markUnderstood(repoPath, layer, itemId);

    // When a component (area) is marked understood, also mark its files as understood
    if (layer === 'component') {
      const area = this.areas.find(a => a.id === itemId);
      if (area) {
        for (const filePath of area.affectedFiles) {
          repo.markUnderstood(repoPath, 'file', `file-${filePath}`);
        }
      }
    }

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

  /** Detect and mark stale understanding items based on files changed since last session. */
  private async detectStaleness(repoPath: string): Promise<void> {
    const understandingRepo = this.db.getUnderstandingRepo();
    const items = understandingRepo.getForRepo(repoPath);

    // Get files that changed since last session
    const git = simpleGit(repoPath);
    const lastSession = this.db.getSessionRepo().getLastSessionForRepo(repoPath);

    if (!lastSession?.completedAt) return;

    try {
      const log = await git.log({
        '--since': lastSession.completedAt,
        '--name-only': null,
      } as any);

      const changedFiles = new Set<string>();
      for (const entry of log.all) {
        const files = (entry as any).diff?.files ?? [];
        for (const f of files) {
          changedFiles.add(f.file);
        }
      }

      // Mark understanding items as stale if their files changed
      for (const item of items) {
        if (item.status === 'understood' && item.layer === 'file') {
          const filePath = item.itemName;
          if (changedFiles.has(filePath)) {
            understandingRepo.markStale(repoPath, 'file', item.itemId);
            // Propagate staleness up: mark parent component as stale too
            if (item.parentId) {
              understandingRepo.markStale(repoPath, 'component', item.parentId);
            }
          }
        }
      }
    } catch {
      // Ignore errors in staleness detection
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
