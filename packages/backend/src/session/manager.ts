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
  VisualLayer,
} from '@interactive-reviewer/shared';
import { DEFAULT_MODES } from '@interactive-reviewer/shared';
import { v4 as uuid } from 'uuid';
import path from 'path';
import fs from 'fs';
import simpleGit from 'simple-git';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { GitAnalyzer } from '../git/analyzer.js';
import { readCommits } from '../git/commit-reader.js';
import { extractDiffs } from '../git/diff-parser.js';
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
  private visualLayer: VisualLayer = 1;

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
      case 'action:confirm_issue':
        this.confirmIssue(event.payload).catch(err => {
          this.emit({ type: 'action:issue_failed', payload: { error: err.message } });
        });
        break;
    }
  }

  private async confirmIssue(payload: { title: string; body: string; labels: string[] }) {
    const { GitHubIntegration } = await import('../integrations/github.js');

    if (!await GitHubIntegration.isAvailable()) {
      this.emit({ type: 'action:issue_failed', payload: { error: 'GitHub CLI (gh) not installed. Install it from https://cli.github.com' } });
      return;
    }

    const repoPath = this.activeRepoPath || this.config.repoPath;
    const result = await GitHubIntegration.createIssue(repoPath, payload.title, payload.body, payload.labels);

    this.emit({ type: 'action:issue_created', payload: result });
    this.emit({ type: 'narration:greeting', payload: { text: `Issue created: number ${result.number}. You can find it at ${result.url}` } });
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
          // Query understanding repo for weakest areas
          const understandingState = this.db.getUnderstandingRepo().getState(effectivePath);
          const weakAreas = understandingState.layers
            .flatMap(layer => {
              const items = this.db.getUnderstandingRepo().getByLayer(effectivePath, layer.level);
              return items
                .filter(i => i.status !== 'understood')
                .map(i => ({ name: i.itemName, percentage: 0 }));
            })
            .slice(0, 5);

          // Build quiet-week greeting
          let greetingText: string;
          let proposalMessage: string;
          if (weakAreas.length > 0) {
            const weakNames = weakAreas.slice(0, 3).map(a => a.name).join(', ');
            greetingText = `Nothing's changed in ${repoName} since your last review. But I noticed you haven't explored ${weakNames} yet.`;
            proposalMessage = `No new commits since your last review. I'd suggest exploring some areas you haven't covered yet, like ${weakNames}. Or you can do a full walkthrough to explore the architecture, or wrap up.`;
          } else {
            greetingText = `Nothing's changed in ${repoName} since your last review. Want to do a full walkthrough instead?`;
            proposalMessage = `No new commits since your last review. You can do a full walkthrough to explore the architecture, or wrap up.`;
          }

          this.emit({
            type: 'narration:greeting',
            payload: { text: greetingText },
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
              message: proposalMessage,
              suggestedOrder: [],
              areas: weakAreas.map((a, i) => ({ id: `weak-${i}`, name: a.name, significance: 'minor' as const })),
            },
          });
          this.setState({ phase: 'PROPOSAL' });
          return;
        }
        // Full walkthrough with zero recent commits: use ALL commits for analysis
        // The user wants to explore the whole project, not just recent changes
        if (this.entryMode === 'full_walkthrough') {
          const gitAll = simpleGit(effectivePath);
          const allCommitInfos = await readCommits(gitAll, new Date(0), now, 200);
          if (allCommitInfos.length > 0) {
            const allDiffs = await extractDiffs(gitAll, allCommitInfos);
            commits.push(...allDiffs);
          }
        }
      }

      // Detect languages from file extensions in the diffs (or from file tree if no diffs)
      let languages: string[];
      if (commits.length > 0) {
        languages = this.detectLanguages(commits);
      } else {
        // Fallback: detect from file tree
        const gitLang = simpleGit(effectivePath);
        const files = (await gitLang.raw(['ls-files']).catch(() => '')).split('\n').filter(Boolean);
        const extCounts = new Map<string, number>();
        for (const f of files) {
          const ext = f.split('.').pop()?.toLowerCase() ?? '';
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
        const langMap: Record<string, string> = {
          ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
          py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby',
          php: 'PHP', c: 'C', cpp: 'C++', cs: 'C#', swift: 'Swift', kt: 'Kotlin',
        };
        languages = [...extCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([ext]) => langMap[ext] ?? ext)
          .filter(Boolean);
      }
      this.detectedLanguages = languages;

      // Get previous session summary (for "Previously on..." -- reuses lookup from above)
      const previousSummary = (previousSessionRecord && previousSessionRecord.id !== sessionId)
        ? previousSessionRecord.summary
        : undefined;

      // Determine whether to use AI-powered analysis
      // Resolve AI client based on intelligence mode
      const apiKey = this.config.anthropicApiKey;
      const mode = this.config.intelligenceMode;
      let aiClient: import('../intelligence/client-interface.js').IClaudeClient | null = null;

      if (mode === 'cloud' && apiKey) {
        const { ClaudeClient } = await import('../intelligence/claude-client.js');
        aiClient = new ClaudeClient(apiKey);
      } else if (mode === 'local' || mode === 'auto') {
        // Try Claude Code CLI first
        const { ClaudeCodeClient } = await import('../intelligence/claude-code-client.js');
        if (await ClaudeCodeClient.isAvailable()) {
          aiClient = new ClaudeCodeClient();
        } else if (apiKey) {
          // Fall back to API if CLI not available
          const { ClaudeClient } = await import('../intelligence/claude-client.js');
          aiClient = new ClaudeClient(apiKey);
        }
      }

      const useAI = !!aiClient && commits.length > 0;

      let areas: Area[];
      let concerns: Concern[] = [];

      if (useAI) {
        // ── AI-powered analysis ──────────────────────────────────────────
        const intelligence = new IntelligenceAnalyzer(aiClient!, {
          repoName,
          languages,
          sinceDate: since.toISOString().split('T')[0],
          untilDate: now.toISOString().split('T')[0],
          commitCount: commits.length,
          previousSessionSummary: previousSummary,
        });
        this.activeAnalyzer = intelligence;

        // Initialize the intent classifier
        this.intentClassifier = new IntentClassifier(aiClient!);

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

        const impactRankingPromise = (async () => {
          try {
            return await intelligence.rankByImpact(areas);
          } catch {
            // Non-critical — skip if impact ranking fails
            return null;
          }
        })();

        const [narrativeResults, detectedConcerns, architecture, impactRankings] = await Promise.all([
          Promise.all(narrativePromises),
          concernsPromise,
          architecturePromise,
          impactRankingPromise,
        ]);

        concerns = detectedConcerns;

        // Apply impact rankings to areas and sort by impact score descending
        if (impactRankings) {
          for (const ranking of impactRankings) {
            const area = areas[ranking.areaIndex];
            if (area) {
              area.impactScore = ranking.overallImpact;
              area.impactSummary = ranking.impactSummary;
              area.riskFlags = ranking.riskFlags;
              areaRepo.updateArea(area.id, {
                impactScore: ranking.overallImpact,
                impactSummary: ranking.impactSummary,
                riskFlags: ranking.riskFlags,
                theme: area.theme,
              });
            }
          }
          // Sort areas by impact score descending (highest impact first)
          areas.sort((a, b) => (b.impactScore ?? 0) - (a.impactScore ?? 0));
          // Update order indices after sorting
          areas.forEach((area, idx) => {
            area.orderIndex = idx;
          });
        }

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
            conceptualSteps: [],
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
        // Transition through layer 2 (concept) before arriving at architecture
        this.setVisualLayer(2);
        this.setState({ phase: 'ARCHITECTURE_OVERVIEW' });
        this.setVisualLayer(3);
        break;

      case 'ARCHITECTURE_OVERVIEW':
        // Mark architecture-level understanding
        this.markPhaseUnderstood('architecture', this.activeRepoPath, 'architecture');
        if (this.areas.length > 0) {
          this.setState({ phase: 'COMPONENT_TOUR', areaIndex: 0, segmentIndex: 0 });
          this.setVisualLayer(4, this.areas[0]?.id);
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
        if (nextPhase === 'COMPONENT_TOUR') {
          this.setVisualLayer(4, this.areas[nextIndex]?.id);
        }
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
      const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
      const filePath = currentArea?.affectedFiles?.[0];
      this.setVisualLayer(5, undefined, filePath);
    }
  }

  /** Quick-match well-known voice commands without needing the AI classifier. */
  private handleQuickCommand(text: string): boolean {
    const lower = text.toLowerCase().trim();
    const QUICK_COMMANDS: Record<string, () => void> = {
      'next': () => this.handleNavigation('command:next'),
      'move on': () => this.handleNavigation('command:next'),
      'continue': () => this.handleNavigation('command:next'),
      'go back': () => this.handleNavigation('command:previous'),
      'previous': () => this.handleNavigation('command:previous'),
      'back': () => this.handleNavigation('command:previous'),
      'skip': () => this.handleNavigation('command:skip'),
      'skip this': () => this.handleNavigation('command:skip'),
      'pause': () => this.handleNavigation('command:pause'),
      'stop': () => this.handleNavigation('command:pause'),
      'resume': () => this.handleNavigation('command:resume'),
      'play': () => this.handleNavigation('command:resume'),
      'dive deeper': () => this.handleNavigation('command:dive_deeper'),
      'more detail': () => this.handleNavigation('command:dive_deeper'),
      'tell me more': () => this.handleNavigation('command:dive_deeper'),
      'export slides': () => this.handleExport('slides'),
      'make slides': () => this.handleExport('slides'),
      'export markdown': () => this.handleExport('markdown'),
      'make a summary': () => this.handleExport('markdown'),
      'write it up': () => this.handleExport('markdown'),
      'exit': () => this.setState({ phase: 'IDLE' }),
      'go home': () => this.setState({ phase: 'IDLE' }),
      'back to lobby': () => this.setState({ phase: 'IDLE' }),
      'quit': () => this.setState({ phase: 'IDLE' }),
      'back to the tour': () => this.resumeTour(),
      'resume tour': () => this.resumeTour(),
      'resume the tour': () => this.resumeTour(),
      'zoom in': () => this.handleZoomCommand('zoom_in'),
      'zoom out': () => this.handleZoomCommand('zoom_out'),
      'show me the big picture': () => this.handleZoomCommand('zoom_out'),
      'show the overview': () => this.handleZoomCommand('zoom_out'),
      'show the code': () => this.handleZoomCommand('zoom_to_code'),
      'show the architecture': () => this.handleZoomCommand('zoom_to_architecture'),
      // Action commands
      'create a ticket': () => this.triggerSkill('create_issue'),
      'create an issue': () => this.triggerSkill('create_issue'),
      'file an issue': () => this.triggerSkill('create_issue'),
      'open a ticket': () => this.triggerSkill('create_issue'),
      'share this': () => this.triggerSkill('share_explanation'),
      'share this explanation': () => this.triggerSkill('share_explanation'),
      'copy this': () => this.triggerSkill('share_explanation'),
    };
    for (const [phrase, handler] of Object.entries(QUICK_COMMANDS)) {
      if (lower === phrase || lower.startsWith(phrase + ' ')) {
        handler();
        return true;
      }
    }
    // Toggle commands
    const toggleMatch = lower.match(/^turn (on|off) (narration|advisory|active learning|alerts)$/);
    if (toggleMatch) {
      const [, state, mode] = toggleMatch;
      const modeMap: Record<string, string> = {
        'narration': 'narration',
        'advisory': 'advisory',
        'active learning': 'activeLearning',
        'alerts': 'alerts',
      };
      const modeKey = modeMap[mode];
      if (modeKey) {
        this.handleModeToggle(modeKey, state === 'on');
        return true;
      }
    }
    if (lower === 'mute') { this.handleModeToggle('narration', false); return true; }
    if (lower === 'unmute') { this.handleModeToggle('narration', true); return true; }
    if (lower === 'show concerns' || lower === 'show issues') { this.handleModeToggle('advisory', true); return true; }
    if (lower === 'hide concerns') { this.handleModeToggle('advisory', false); return true; }
    return false;
  }

  private triggerSkill(skillName: SkillName): void {
    const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
    this.executeSkillWithDeviation(skillName, {}, currentArea).catch(err => {
      this.emit({ type: 'error', payload: { code: 'SKILL_FAILED', message: err.message ?? 'Skill execution failed', recoverable: true } });
    });
  }

  private async handleQuestion(question: string) {
    // Voice-first: answer inline via narration, don't transition to QA modal.
    // The answer is spoken aloud and shown in the narration bar.

    const answerAndNarrate = async (answer: string) => {
      // Emit as narration greeting so the orchestrator speaks it
      this.emit({ type: 'narration:greeting', payload: { text: answer } });
      // Also emit as qa:answer_chunk for the content panel
      this.emit({ type: 'qa:answer_chunk', payload: { text: answer, done: true } });
    };

    // Try the active analyzer first
    if (this.activeAnalyzer) {
      try {
        const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
        const context = `Current area: ${currentArea?.name ?? 'none'}. ${currentArea?.description ?? ''}`;
        const answer = await this.activeAnalyzer.answerQuestion(question, context);
        await answerAndNarrate(answer);
        return;
      } catch (err: any) {
        console.error('Q&A error:', err.message);
      }
    }

    // Try to create a client on-the-fly
    try {
      const mode = this.config.intelligenceMode;
      if (mode === 'local' || mode === 'auto') {
        const { ClaudeCodeClient } = await import('../intelligence/claude-code-client.js');
        if (await ClaudeCodeClient.isAvailable()) {
          const client = new ClaudeCodeClient();
          const answer = await client.streamText({
            system: 'You are helping a developer understand their codebase during an interactive review session. Answer concisely and conversationally — this will be spoken aloud.',
            messages: [{ role: 'user' as const, content: question }],
          });
          await answerAndNarrate(answer);
          return;
        }
      }
      if ((mode === 'cloud' || mode === 'auto') && this.config.anthropicApiKey) {
        const { ClaudeClient } = await import('../intelligence/claude-client.js');
        const client = new ClaudeClient(this.config.anthropicApiKey);
        const answer = await client.streamText({
          system: 'You are helping a developer understand their codebase during an interactive review session. Answer concisely and conversationally — this will be spoken aloud.',
          messages: [{ role: 'user' as const, content: question }],
        });
        await answerAndNarrate(answer);
        return;
      }
    } catch (err: any) {
      console.error('Q&A fallback error:', err.message);
    }

    await answerAndNarrate("Sorry, I couldn't process that. Make sure the Claude CLI is installed or an API key is set.");
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

    // Fast-path: check for well-known navigation/action phrases before AI classification
    const handled = this.handleQuickCommand(text);
    if (handled) return;

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

      // Handle export commands
      if (classification.navigationCommand === 'export_slides') {
        this.handleExport('slides');
        return;
      }
      if (classification.navigationCommand === 'export_markdown') {
        this.handleExport('markdown');
        return;
      }

      // Handle mode toggle commands
      const toggleMatch = classification.navigationCommand.match(/^toggle_(\w+)_(on|off)$/);
      if (toggleMatch) {
        const [, modeKey, state] = toggleMatch;
        this.handleModeToggle(modeKey, state === 'on');
        return;
      }

      // Handle exit session
      if (classification.navigationCommand === 'exit_session') {
        this.setState({ phase: 'IDLE' });
        return;
      }

      // Handle zoom commands from classifier
      if (['zoom_in', 'zoom_out', 'zoom_to_code', 'zoom_to_architecture'].includes(classification.navigationCommand)) {
        this.handleZoomCommand(classification.navigationCommand);
        return;
      }

      // Handle action commands that map to skills
      if (['create_issue', 'share_explanation'].includes(classification.navigationCommand)) {
        this.triggerSkill(classification.navigationCommand as SkillName);
        return;
      }

      const navMap: Record<string, string> = {
        next: 'command:next',
        previous: 'command:previous',
        skip: 'command:skip',
        pause: 'command:pause',
        resume: 'command:resume',
        dive_deeper: 'command:dive_deeper',
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
      this.setVisualLayer(1);
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

  private handleZoomCommand(command: string) {
    switch (command) {
      case 'zoom_in': {
        const next = Math.min(5, this.visualLayer + 1) as VisualLayer;
        this.setVisualLayer(next);
        break;
      }
      case 'zoom_out': {
        const prev = Math.max(1, this.visualLayer - 1) as VisualLayer;
        this.setVisualLayer(prev);
        break;
      }
      case 'zoom_to_code':
        this.setVisualLayer(5);
        break;
      case 'zoom_to_architecture':
        this.setVisualLayer(3);
        break;
    }
  }

  private setVisualLayer(layer: VisualLayer, targetNodeId?: string, filePath?: string) {
    this.visualLayer = layer;
    this.state.visualLayer = layer;
    this.emit({
      type: 'visual:layer_change',
      payload: { layer, targetNodeId, filePath },
    });
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

    if (!this.activeAnalyzer) {
      return {
        overview: `This is ${repoName}. Let me walk you through the codebase.`,
        purpose: repoName,
        techStack: languages,
        keyAreas: [],
        conceptualSteps: [],
      };
    }

    const intelligence = this.activeAnalyzer;

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
