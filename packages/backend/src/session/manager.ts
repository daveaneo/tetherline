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
} from '@tetherline/shared';
import { DEFAULT_MODES } from '@tetherline/shared';
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
import { ContextCacheWarmer } from '../cache/warmer.js';
import { ContextComposer } from '../cache/context-composer.js';
import { Navigator, frameFromBriefing } from './navigator.js';
import { resolveNavOp, type NavOp } from './navigator-vocab.js';
import { isConfirmationPhrase } from './confirmation-phrases.js';
import { getTraceRecorder } from '../dev/trace.js';
import { scoreQuizAnswer } from '../intelligence/quiz.js';
import { getDefaultLLMAdapter } from '../intelligence/llm/index.js';
import type { ComprehensionItemLayer, ComprehensionLevel } from '@tetherline/shared';

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
  private contextComposer: ContextComposer | null = null;
  private navigator = new Navigator();
  /** Timestamp of the last narration:briefing emit — lets us derive a rough
   *  resume position when the user interrupts mid-speech. */
  private lastBriefingEmittedAt: number | null = null;
  private lastBriefingId: string | null = null;
  /** Whether the user currently holds the conversational floor. When true, the
   *  server suppresses outbound narration — prevents AI-on-user overlap. */
  private userSpeaking = false;
  /** After the user stops speaking, the AI waits this many ms before its next
   *  audio output. Blocks the "AI jumped in too fast" pattern. Tunable. */
  private readonly POST_USER_SILENCE_MS = 600;
  private userStoppedAt: number | null = null;
  /** Confirmation phrases are only treated as `confirmed` within this many ms
   *  of the last briefing being delivered. Prevents idle "got it, I need
   *  coffee" from false-positive-confirming. */
  private readonly CONFIRMATION_WINDOW_MS = 60_000;
  /** Rolling Q&A history threaded into the system prompt for follow-up
   *  coherence ("what about it?" needs to know what "it" was). Capped to
   *  the last few turns so prompt size stays small. */
  private qaTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private readonly QA_HISTORY_MAX = 6;
  /** Per-session answer-length preference. Sticks until the user changes
   *  it ("shorter" / "more detail"). The QA scaffold uses this to steer
   *  the LLM's output length on every answer. */
  private depthTier: import('../intelligence/depth-modifiers.js').DepthTier = 'normal';
  /** Cooldown per comprehension item — same item can only transition once every
   *  30s, protects against chatty transcripts double-counting. */
  private readonly COMPREHENSION_COOLDOWN_MS = 30_000;
  private lastComprehensionTouchAt = new Map<string, number>();

  private rawEmit: (event: ServerEvent) => void;
  /** Event types that carry AI speech. When the user holds the floor, these
   *  are suppressed; everything else (state changes, progress, errors, etc.)
   *  flows through untouched. */
  private readonly NARRATION_EVENT_TYPES = new Set<ServerEvent['type']>([
    'narration:greeting',
    'narration:segment_ready',
    'narration:text',
    'narration:quick_answer',
    'narration:briefing',
    'qa:answer_chunk',
  ]);

  constructor(
    private db: Database,
    private config: AppConfig,
    emit: (event: ServerEvent) => void,
  ) {
    this.rawEmit = emit;
  }

  /** Gated emit — drops AI speech events while the user holds the floor.
   *  All other events (state changes, errors, progress) flow through.
   *
   *  Gate is disabled when `TETHERLINE_DISABLE_FLOOR_SUPPRESSION=1` so we can
   *  measure the pre-fix baseline reproducibly. */
  private emit(event: ServerEvent): void {
    const gateDisabled = process.env.TETHERLINE_DISABLE_FLOOR_SUPPRESSION === '1';
    if (!gateDisabled && this.NARRATION_EVENT_TYPES.has(event.type) && this.shouldSuppressNarration()) {
      getTraceRecorder()?.emit({
        kind: 'tts.drop',
        sessionId: this.context.sessionId || null,
        payload: { eventType: event.type, reason: this.userSpeaking ? 'user_speaking' : 'post_user_silence' },
      });
      return;
    }
    this.traceNarrationEvent(event);
    this.rawEmit(event);
  }

  private traceNarrationEvent(event: ServerEvent): void {
    if (
      event.type !== 'narration:greeting' &&
      event.type !== 'narration:segment_ready' &&
      event.type !== 'narration:quick_answer' &&
      event.type !== 'narration:briefing' &&
      event.type !== 'narration:text' &&
      event.type !== 'narration:stream_chunk' &&
      event.type !== 'qa:answer_chunk'
    ) return;
    const payload = event.payload as Record<string, unknown>;
    const text =
      typeof payload.text === 'string' ? payload.text :
      typeof payload.answer === 'string' ? payload.answer :
      typeof (payload.segment as any)?.text === 'string' ? (payload.segment as any).text :
      '';
    getTraceRecorder()?.emit({
      kind: 'tts.emit',
      sessionId: this.context.sessionId || null,
      payload: {
        eventType: event.type,
        text,
        // Pass through karaoke-ball anchors when present so the trace
        // shows which nodes will pulse during this chunk's playback.
        referencedNodes: (payload.referencedNodes as string[] | undefined) ?? undefined,
      },
    });
  }

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
      case 'command:level_up':
        this.handleLevelUp();
        break;
      case 'command:quiz_start':
        this.handleQuizStart().catch(err => {
          this.emit({ type: 'error', payload: { code: 'QUIZ_FAILED', message: err.message ?? 'Quiz failed', recoverable: true } });
        });
        break;
      case 'user:quiz_answer':
        this.handleQuizAnswer(event.payload.questionId, event.payload.answer).catch(err => {
          this.emit({ type: 'error', payload: { code: 'QUIZ_FAILED', message: err.message ?? 'Quiz answer failed', recoverable: true } });
        });
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
      case 'user:speaking_started':
        this.markUserSpeakingStarted();
        break;
      case 'user:speaking_stopped':
        this.markUserSpeakingStopped();
        break;
      case 'action:confirm_issue':
        this.confirmIssue(event.payload).catch(err => {
          this.emit({ type: 'action:issue_failed', payload: { error: err.message } });
        });
        break;
      case 'session:start_onboarding':
        this.startOnboardingSession(event.payload.repoPath, event.payload.programId, event.payload.dayNumber).catch(err => {
          this.emit({ type: 'error', payload: { code: 'ONBOARDING_FAILED', message: err.message, recoverable: true } });
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

  private async startOnboardingSession(repoPath: string, programId?: string, dayNumber?: number) {
    const effectivePath = repoPath || this.config.repoPath;
    const repoName = path.basename(effectivePath);

    // Get or generate program
    let program: any;
    if (programId) {
      program = this.db.getOnboardingRepo().getProgram(programId);
    } else {
      const programs = this.db.getOnboardingRepo().getProgramsForRepo(effectivePath);
      program = programs[0]; // Use most recent
    }

    if (!program) {
      this.emit({ type: 'error', payload: { code: 'NO_PROGRAM', message: 'No onboarding program found. Generate one first via the API.', recoverable: true } });
      return;
    }

    // Get or start progress
    let progress = this.db.getOnboardingRepo().getProgress(program.id);
    if (!progress) {
      progress = this.db.getOnboardingRepo().startProgress(program.id);
    }

    const day = dayNumber ?? progress.currentDay;
    const dayData = program.days[day - 1];
    if (!dayData) {
      this.emit({ type: 'error', payload: { code: 'INVALID_DAY', message: `Day ${day} not found in program`, recoverable: true } });
      return;
    }

    // Emit onboarding day event
    this.emit({
      type: 'session:onboarding_day',
      payload: { day: dayData, programName: program.name, totalDays: program.totalDays },
    });

    // Set visual layer based on the day's target layer
    const layerMap: Record<string, VisualLayer> = {
      project: 1,
      conceptual: 2,
      architecture: 3,
      component: 4,
      code: 5,
    };
    const targetLayer = layerMap[dayData.targetLayer] ?? 1;
    this.setVisualLayer(targetLayer);

    // Set entry mode and start a regular session scoped to this day's content
    this.entryMode = 'onboarding';
    await this.startSession(effectivePath, 365); // Use full history for onboarding
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

      // Cross-session recall: surface up to 5 distinct questions the user
      // asked in prior sessions PLUS the comprehension items they got
      // somewhere meaningful with last time, annotated with commits-
      // since so they can see if anything's drifted. Frontend renders
      // these in the GapsPanel "pick up where you left off" section.
      try {
        const priorQuestions = this.db.getQAHistoryRepo().recentQuestions(effectivePath, {
          excludeSessionId: sessionId,
          limit: 5,
        });
        const recallItems = await this.collectRecallItems(effectivePath, sessionId);
        if (priorQuestions.length > 0 || recallItems.length > 0) {
          this.emit({
            type: 'session:recall',
            payload: { questions: priorQuestions, items: recallItems },
          });
        }
      } catch (err: any) {
        console.warn('Failed to fetch recall context:', err.message);
      }

      // Instant opener: if we have a cached project briefing from a prior
      // session, deliver it NOW (before the long ANALYZING block). User hears
      // a coherent 15s pitch within 500ms. Analysis continues in background.
      this.navigator.reset();
      const cachedProjectBriefing = this.db.getBriefingRepo().get(effectivePath, 'project');
      if (cachedProjectBriefing) {
        this.deliverBriefing(cachedProjectBriefing, 'session_start');
      }

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

      // Quick preview: emit everything we can derive from git alone so the
      // frontend has something to render in <1s instead of staring at a spinner
      // while LLM analysis runs for 30-90s.
      try {
        const contribCounts = new Map<string, number>();
        const fileTouches = new Map<string, number>();
        const folderFileCounts = new Map<string, Set<string>>();
        for (const cd of commits) {
          const author = cd.commit.author;
          contribCounts.set(author, (contribCounts.get(author) ?? 0) + 1);
          for (const fc of (cd.commit.filesChanged ?? [])) {
            const f = fc.path;
            fileTouches.set(f, (fileTouches.get(f) ?? 0) + 1);
            const top = f.split('/')[0] || '.';
            if (!folderFileCounts.has(top)) folderFileCounts.set(top, new Set());
            folderFileCounts.get(top)!.add(f);
          }
        }
        this.emit({
          type: 'session:quick_preview',
          payload: {
            repoName,
            commitCount: commits.length,
            contributors: [...contribCounts.entries()]
              .map(([name, count]) => ({ name, commits: count }))
              .sort((a, b) => b.commits - a.commits)
              .slice(0, 8),
            topFolders: [...folderFileCounts.entries()]
              .map(([path, files]) => ({ path, fileCount: files.size }))
              .sort((a, b) => b.fileCount - a.fileCount)
              .slice(0, 8),
            topFiles: [...fileTouches.entries()]
              .map(([path, touches]) => ({ path, touches }))
              .sort((a, b) => b.touches - a.touches)
              .slice(0, 10),
            sinceDate: since.toISOString(),
            untilDate: now.toISOString(),
          },
        });
      } catch {
        // Best-effort — don't block analysis if preview fails
      }

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
          aiClient = new ClaudeCodeClient('sonnet', effectivePath);
        } else if (apiKey) {
          // Fall back to API if CLI not available
          const { ClaudeClient } = await import('../intelligence/claude-client.js');
          aiClient = new ClaudeClient(apiKey);
        }
      }

      const useAI = !!aiClient && commits.length > 0;

      // Warm the context cache, then rebuild briefings from it.
      try {
        const cacheWarmer = new ContextCacheWarmer(
          this.db.getContextCacheRepo(),
          aiClient,
          (msg) => this.emit({ type: 'analysis:progress', payload: { phase: 'warming_cache', progress: 0.1, message: msg } }),
        );
        await cacheWarmer.warm(effectivePath);
        this.contextComposer = new ContextComposer(this.db.getContextCacheRepo(), effectivePath);

        // Briefings are deterministic derivations of the cache — rebuilding them
        // on every session start is cheap and keeps them in sync with any edits.
        // Passing the comprehension repo lets the warmer degrade confirmed
        // items when their underlying briefing has drifted (staleness).
        const { warmBriefings } = await import('../briefing/warmer.js');
        const warmResult = await warmBriefings(
          effectivePath,
          this.db.getContextCacheRepo(),
          this.db.getBriefingRepo(),
          aiClient,
          this.db.getComprehensionRepo(),
        );
        for (const staledId of warmResult.staled) {
          const item = this.db.getComprehensionRepo().get(effectivePath, staledId);
          if (item) {
            this.emit({
              type: 'comprehension:updated',
              payload: {
                itemId: item.itemId,
                label: item.label,
                layer: item.layer,
                level: item.level,
                previousLevel: 'confirmed', // degraded from a higher level
                reason: 'stale',
              },
            });
          }
        }

        // Pre-warm diagram payloads (project + per-module, both views)
        // so click-to-drill on the radial map is instant. Cassette-backed
        // for the LLM portion. Skipped on warm starts when source hash
        // hasn't drifted.
        try {
          const { warmDiagrams } = await import('../intelligence/diagram-warmer.js');
          await warmDiagrams(
            effectivePath,
            this.db.getContextCacheRepo(),
            this.db.getDiagramCacheRepo(),
            this.db.getComprehensionRepo(),
            aiClient ? getDefaultLLMAdapter() : null,
            (msg) => this.emit({ type: 'analysis:progress', payload: { phase: 'warming_cache', progress: 0.55, message: msg } }),
          );
        } catch (err: any) {
          console.warn('Failed to warm diagrams:', err.message);
        }
      } catch {
        // Cache warming is best-effort; don't block session start
        this.contextComposer = null;
      }

      let areas: Area[];
      let concerns: Concern[] = [];

      if (useAI) {
        // ── AI-powered analysis ──────────────────────────────────────────
        const intelligence = new IntelligenceAnalyzer(aiClient!, {
          repoName,
          repoPath: effectivePath,
          languages,
          sinceDate: since.toISOString().split('T')[0],
          untilDate: now.toISOString().split('T')[0],
          commitCount: commits.length,
          previousSessionSummary: previousSummary,
          contextComposer: this.contextComposer ?? undefined,
        });
        this.activeAnalyzer = intelligence;

        // Initialize the intent classifier
        this.intentClassifier = new IntentClassifier(aiClient!);

        // Step 1: Semantic clustering. Cached by commit-SHA set: re-runs
        // ONLY when the user's commit window changes. The cluster output
        // is a function of the commits alone, so the cache is sound across
        // sessions for the same repo + same commits.
        this.emit({
          type: 'analysis:progress',
          payload: { phase: 'clustering', progress: 0.5, message: 'AI is grouping commits into areas...' },
        });
        const { llmCacheWrap } = await import('../intelligence/llm-cache.js');
        const llmCache = this.db.getLlmCallCacheRepo();
        const commitShas = commits.map(c => c.commit.hash).sort();
        areas = await llmCacheWrap(
          { cache: llmCache, repoPath: effectivePath, phase: 'cluster-commits', inputs: { commitShas } },
          () => intelligence.clusterCommits(commits, sessionId),
        );
        // Cached clusterCommits embeds the sessionId from the FIRST run
        // into each area; rewrite it to the current session so DB
        // foreign-key constraints (areas.session_id → sessions.id) hold.
        for (const area of areas) {
          area.sessionId = sessionId;
          area.id = `${sessionId}-${area.orderIndex}`;
        }

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

        // Run narrative generation for each area, concerns detection, and architecture in parallel.
        // Each per-area narrative is cached by (areaCommitShas, areaName) —
        // if the same commits cluster into the same area on a re-run, the
        // narrative is identical, so reuse.
        const narrativePromises = areasWithContent.map(async (area, idx) => {
          const segments = await llmCacheWrap(
            {
              cache: llmCache,
              repoPath: effectivePath,
              phase: 'generate-narrative',
              inputs: { areaName: area.name, areaCommitShas: [...area.commitHashes].sort() },
            },
            () => intelligence.generateNarrative(area, commits),
          );
          const overview = segments.length > 0 ? segments[0].text : area.description;
          areaRepo.updateArea(area.id, {
            narrativeText: overview,
            narrationSegments: JSON.stringify(segments),
          });
          // Stream each area's narrative the moment it's ready so the frontend
          // can render content progressively instead of waiting for Promise.all
          // across all areas + concerns + architecture.
          this.emit({
            type: 'analysis:area_narrative_ready',
            payload: { areaId: area.id, narrativeText: overview, segments },
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
          // Cached by commit-SHA set — same commits → same concerns.
          // Rewrite sessionId on cache-hit so the per-area FK still resolves.
          const cached = await llmCacheWrap(
            { cache: llmCache, repoPath: effectivePath, phase: 'detect-concerns', inputs: { commitShas } },
            () => intelligence.detectConcerns(commits, sessionId),
          );
          return cached.map(c => ({ ...c, sessionId }));
        })();

        const architecturePromise = (async () => {
          this.emit({
            type: 'analysis:progress',
            payload: { phase: 'generating_architecture', progress: 0.75, message: 'Generating architecture diagram...' },
          });
          // Cached by fileTree content + the area names it's diagramming.
          return llmCacheWrap(
            {
              cache: llmCache,
              repoPath: effectivePath,
              phase: 'generate-architecture',
              inputs: { fileTree: [...fileTree].sort(), areaNames: areas.map(a => a.name).sort() },
            },
            () => intelligence.generateArchitecture(fileTree, areas),
          );
        })();

        const impactRankingPromise = (async () => {
          try {
            return await llmCacheWrap(
              {
                cache: llmCache,
                repoPath: effectivePath,
                phase: 'rank-impact',
                inputs: { areas: areas.map(a => ({ name: a.name, commitShas: [...a.commitHashes].sort() })) },
              },
              () => intelligence.rankByImpact(areas),
            );
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

        // Surface-level code observations (TODO clusters, long files,
        // untested modules). Cheap regex pass over the file list — no
        // LLM. Gives the user a curated set of "things worth looking at"
        // alongside the LLM-detected concerns.
        try {
          const { observeCode } = await import('../intelligence/code-observations.js');
          const cachedFiles = this.db.getContextCacheRepo().getFilesForRepo(effectivePath);
          const cachedModules = this.db.getContextCacheRepo().getModulesForRepo(effectivePath);
          const observed = observeCode({
            repoPath: effectivePath,
            allFiles: cachedFiles.map(f => f.filePath),
            modules: cachedModules.map(m => ({ name: m.modulePath, pathPrefix: m.modulePath })),
            max: 8,
          });
          for (const c of observed) c.sessionId = sessionId;
          concerns = [...concerns, ...observed];
        } catch {
          // Non-critical
        }

        // Store concerns in DB
        this.storeConcerns(concerns);
        this.context.concerns = concerns;

        // Generate and store session summary for next time's "Previously on..."
        // Cached on (areaNames, concernTitles) — the recap is a function of
        // those inputs alone, so warm runs reuse it. Without this cache,
        // every session paid ~3s for an LLM call that produced an
        // identical recap.
        try {
          const sessionSummaryText = await llmCacheWrap(
            {
              cache: llmCache,
              repoPath: effectivePath,
              phase: 'session-summary',
              inputs: {
                areaNames: areas.map(a => a.name).sort(),
                concernTitles: concerns.map(c => c.title).sort(),
              },
            },
            () => intelligence.generateSessionSummary(areas, concerns),
          );
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

  /** Emit a long narration as sequential narration:stream_chunk events
   *  with the same chunker handleQuestion uses. Single source of truth
   *  for "speak this AI text aloud" — was duplicated as raw greeting
   *  emits in skills, the grill loop, and a few other call sites,
   *  each producing the robotic single-shot TTS the user hated.
   *
   *  Also tags each chunk with `referencedNodes` (diagram node labels
   *  mentioned in the chunk's text). Drives the karaoke-ball: as the
   *  AI says "FileLoader handles X, then PairGenerator does Y", the
   *  frontend pulses FileLoader for the first chunk's audio duration,
   *  then PairGenerator for the next. The visual follows the words. */
  private async emitNarrationChunked(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { chunkAnswerWithAnchors } = await import('../intelligence/sentence-chunker.js');
    const nodeLabels = await this.knownNodeLabels();
    const tagged = chunkAnswerWithAnchors(trimmed, nodeLabels);
    if (tagged.length <= 1) {
      // Trivial: one chunk → fall back to greeting (preserves legacy
      // tests/UI flows that listen for narration:greeting on short
      // replies). The user-facing concern (robotic 250-word blobs) is
      // about LONG narrations; one-chunk is fine as a greeting.
      this.emit({ type: 'narration:greeting', payload: { text: trimmed } });
      return;
    }
    const streamId = `nar-${Date.now()}`;
    for (let i = 0; i < tagged.length; i++) {
      this.emit({
        type: 'narration:stream_chunk',
        payload: {
          streamId,
          seq: i,
          text: tagged[i].text,
          isFinal: i === tagged.length - 1,
          referencedNodes: tagged[i].referencedNodes,
        },
      });
    }
  }

  /** Pulls the diagram node labels for the active scope so the chunker
   *  can anchor-tag narration. Cached per-call (the diagram cache is
   *  cheap to read). Falls back to module names from the context cache
   *  when no diagram is loaded yet. */
  private async knownNodeLabels(): Promise<string[]> {
    const repoPath = this.activeRepoPath || this.config.repoPath;
    if (!repoPath) return [];
    try {
      // Pull all diagram views for this repo and union their labels.
      // Module names + file basenames + concept names all become
      // anchor-able tokens in the karaoke ball.
      const labels = new Set<string>();
      const modules = this.db.getContextCacheRepo().getModulesForRepo(repoPath);
      for (const m of modules) labels.add(m.modulePath);
      // Also add a few aliasable variants so "the FileLoader" / "file_loader.py" both anchor.
      for (const m of modules) {
        const base = m.modulePath.split('/').pop();
        if (base) labels.add(base);
      }
      return [...labels].filter(l => l.length >= 3); // skip 1-2 char noise
    } catch { return []; }
  }

  private async handleQuestion(question: string, classifierParams: Record<string, string> = {}) {
    // Voice-first: answer inline via narration, don't transition to QA modal.
    // The answer is spoken aloud and shown in the narration bar.

    // Defense-in-depth: if the transcript is empty / a Whisper hallucination,
    // stay silent. The frontend filter catches most of these — this guards
    // anything that slipped through (other input paths, integration tests,
    // direct WS clients). No reply, no LLM call, no qaTurns mutation.
    if (isLikelyTranscriptionNoise(question)) return;

    const repoPath = this.activeRepoPath || this.config.repoPath;

    const answerAndNarrate = async (answer: string) => {
      this.qaTurns.push({ role: 'user', content: question });
      this.qaTurns.push({ role: 'assistant', content: answer });
      if (this.qaTurns.length > this.QA_HISTORY_MAX) {
        this.qaTurns = this.qaTurns.slice(-this.QA_HISTORY_MAX);
      }
      // Persist for cross-session recall. Best-effort — DB hiccups shouldn't
      // block the spoken reply.
      try {
        const qaHistory = this.db.getQAHistoryRepo();
        qaHistory.record({ repoPath, sessionId: this.context.sessionId, role: 'user', content: question });
        qaHistory.record({ repoPath, sessionId: this.context.sessionId, role: 'assistant', content: answer });
      } catch (err: any) {
        console.warn('Failed to persist QA turn:', err.message);
      }
      // Stream the answer in sentence-sized chunks. The frontend queues
      // each chunk's TTS clip so early sentences play while later ones are
      // still being TTS-generated — perceived first-word time drops a lot
      // on long answers. Short answers (1 chunk) behave identically to the
      // pre-streaming flow.
      const { chunkAnswerWithAnchors } = await import('../intelligence/sentence-chunker.js');
      const nodeLabels = await this.knownNodeLabels();
      const answerChunks = chunkAnswerWithAnchors(answer, nodeLabels);
      // Prepend the depth-change ack as a leading chunk so it plays
      // before the answer (greetings coalesce; stream chunks queue).
      const ackChunk = depthAck ? [{ text: depthAck, referencedNodes: [] as string[] }] : [];
      const allChunks = [...ackChunk, ...answerChunks];
      const streamId = `qa-${Date.now()}`;
      if (allChunks.length <= 1) {
        // Trivial answer: keep the legacy greeting path so existing
        // integration tests / UI flows that listen for `narration:greeting`
        // continue to fire.
        this.emit({ type: 'narration:greeting', payload: { text: answer } });
        return;
      }
      for (let i = 0; i < allChunks.length; i++) {
        this.emit({
          type: 'narration:stream_chunk',
          payload: {
            streamId,
            seq: i,
            text: allChunks[i].text,
            isFinal: i === allChunks.length - 1,
            referencedNodes: allChunks[i].referencedNodes,
          },
        });
      }
      // Note: NOT emitting narration:greeting here — that would cause the
      // frontend orchestrator to ALSO speak the full answer, producing a
      // double-voice. The frontend's stream_chunk handler appends to the
      // conversation history itself.
    };

    const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
    const currentLocation = currentArea
      ? `Phase: ${this.state.phase}. Area: ${currentArea.name}. ${currentArea.description}`
      : `Phase: ${this.state.phase}.`;

    // Build the cached scaffold once — same input both paths. Recent turns
    // include both this session's qaTurns AND prior-session highlights so
    // follow-ups like "what about it?" carry over across days.
    const { buildQAContext } = await import('../intelligence/qa-context.js');
    const { detectDepth } = await import('../intelligence/depth-modifiers.js');
    // Update the session's depth tier from the current question so the
    // scaffold's length guidance matches what the user just asked for.
    const depthSignal = detectDepth(question, this.depthTier);
    this.depthTier = depthSignal.tier;
    // Suppress the depth-ack ("Got it — I'll keep it short.") when the
    // user's request already specifies brevity — those 7 words eat
    // most of a 10-word budget. The trigger words below are the same
    // signals detectDepth uses to set tldr; we avoid double-narrating.
    const userImpliesBrevity = /\b\d+\s+(words?|sentences?|lines?|paragraphs?)\b|\b(brief|brevity|short|terse|concise|tldr|tl;dr|one[\s-]?liner|in\s+a?\s*sentence)\b/i.test(question);
    const depthAck = depthSignal.changed && !userImpliesBrevity
      ? (depthSignal.tier === 'tldr'
          ? "Got it — I'll keep it short."
          : depthSignal.tier === 'deep'
            ? 'Sure, going deeper.'
            : '')
      : '';

    // Pull classifier params (if any) into the user message as
    // natural-language constraints. The 'none' route reaches
    // handleQuestion with the params dict the LLM extracted — handing
    // them through means the conversational handler honors "format:
    // poem, lines: two, length: 10 words" the same way summarize does
    // for its own constraints. Without this, the 'none' path silently
    // drops anything the classifier extracted.
    const { formatParamsAsConstraints } = await import('../skills/params-helper.js');
    const constraintHints = formatParamsAsConstraints(classifierParams, []);
    const userMessage = constraintHints
      ? `${question}\n\n[Honor these constraints exactly: ${constraintHints}. Output ONLY the answer — no preamble like "sure", "here is", "let me", and no trailing follow-up question.]`
      : question;

    const priorTurns = this.db.getQAHistoryRepo().recent(repoPath, {
      excludeSessionId: this.context.sessionId,
      limit: 6,
    });
    const recentTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...priorTurns.map(t => ({ role: t.role, content: t.content })),
      ...this.qaTurns,
    ];
    const baseSystem = (agenticTools: boolean) => buildQAContext(
      this.db.getContextCacheRepo(),
      repoPath,
      {
        currentLocation,
        agenticTools,
        recentTurns,
        depthTier: this.depthTier,
      },
    );

    try {
      const mode = this.config.intelligenceMode;
      if (mode === 'local' || mode === 'auto') {
        const { ClaudeCodeClient } = await import('../intelligence/claude-code-client.js');
        if (await ClaudeCodeClient.isAvailable()) {
          // Local CLI has built-in read/grep/glob tools — give it permission to use them.
          const client = new ClaudeCodeClient('sonnet', repoPath);
          const answer = await client.streamText({
            system: baseSystem(true),
            messages: [{ role: 'user' as const, content: userMessage }],
          });
          await answerAndNarrate(answer);
          return;
        }
      }
      if ((mode === 'cloud' || mode === 'auto') && this.config.anthropicApiKey) {
        const { ClaudeClient } = await import('../intelligence/claude-client.js');
        const client = new ClaudeClient(this.config.anthropicApiKey);
        const answer = await client.streamText({
          system: baseSystem(false),
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

  /** Programmatic "level up" — same effect as the voice phrase "go back".
   *  Pops the navigator and re-emits the parent briefing. UP arrow button
   *  in the chrome wires to this. */
  private handleLevelUp(): void {
    const repoPath = this.activeRepoPath;
    if (!repoPath) return;
    const popped = this.navigator.pop();
    if (!popped) return;
    const current = this.navigator.peek();
    this.emit({
      type: 'navigator:pop',
      payload: {
        poppedBriefingId: popped.briefingId,
        currentBriefingId: current?.briefingId ?? null,
        depth: this.navigator.depth,
        breadcrumb: this.navigator.breadcrumb(),
      },
    });
    if (current) this.reemitBriefing(repoPath, current.briefingId, 'Back up here');
  }

  // ─────────────────────────────────────────────────────────────
  // Quiz: 3 LLM-generated questions per layer. Right answers
  // promote comprehension from 'heard' → 'explained' → 'confirmed'.
  // 3/3 → confirmed, 2/3 → explained, ≤1 → stays heard. Hearing alone
  // never reaches 'explained' — that's the depth lock.
  // ─────────────────────────────────────────────────────────────
  private activeQuiz: {
    briefingId: string;
    layer: ComprehensionItemLayer;
    label: string;
    questions: Array<{ id: string; question: string; expected: string }>;
    answers: Array<{ questionId: string; correct: boolean }>;
    cursor: number;
  } | null = null;

  // ─────────────────────────────────────────────────────────────
  // grill_me: adaptive Socratic grill. Once a grill starts, the
  // user's next utterances are answers to the current question, NOT
  // fresh requests. handleUtterance checks this state at the top and
  // routes accordingly. See intelligence/grill.ts for the LLM logic.
  // ─────────────────────────────────────────────────────────────
  private activeGrill: import('../intelligence/grill.js').GrillSession | null = null;

  private async handleQuizStart(): Promise<void> {
    const repoPath = this.activeRepoPath;
    if (!repoPath) return;
    const current = this.navigator.peek();
    // Fall back to the project briefing when the user hasn't drilled in yet
    // — quiz on the project layer is a perfectly reasonable starting place.
    const briefingId = current?.briefingId ?? 'project';
    const briefing = this.db.getBriefingRepo().get(repoPath, briefingId);
    if (!briefing) {
      this.emit({ type: 'narration:greeting', payload: { text: "There's nothing to quiz on yet. Pick something on the map first." } });
      return;
    }

    // Generate quiz questions. Falls back to deterministic templates if no
    // LLM available — the test fixtures lean on this so the suite stays
    // hermetic.
    const { generateQuiz } = await import('../intelligence/quiz.js');
    const quiz = await generateQuiz({
      briefing,
      cacheRepo: this.db.getContextCacheRepo(),
      repoPath,
      adapter: getDefaultLLMAdapter(),
    });

    this.activeQuiz = {
      briefingId: briefing.id,
      layer: briefing.layer as ComprehensionItemLayer,
      label: briefing.title,
      questions: quiz,
      answers: [],
      cursor: 0,
    };
    this.emitNextQuizQuestion();
  }

  private emitNextQuizQuestion(): void {
    if (!this.activeQuiz) return;
    const q = this.activeQuiz.questions[this.activeQuiz.cursor];
    if (!q) return;
    this.emit({
      type: 'quiz:question',
      payload: {
        questionId: q.id,
        question: q.question,
        index: this.activeQuiz.cursor,
        total: this.activeQuiz.questions.length,
      },
    });
  }

  private async handleQuizAnswer(questionId: string, answer: string): Promise<void> {
    if (!this.activeQuiz) return;
    const q = this.activeQuiz.questions[this.activeQuiz.cursor];
    if (!q || q.id !== questionId) return;

    const correct = scoreQuizAnswer(answer, q.expected);
    this.activeQuiz.answers.push({ questionId, correct });
    this.activeQuiz.cursor += 1;

    if (this.activeQuiz.cursor < this.activeQuiz.questions.length) {
      this.emitNextQuizQuestion();
      return;
    }

    // Done — finalize.
    const correctCount = this.activeQuiz.answers.filter(a => a.correct).length;
    const total = this.activeQuiz.questions.length;
    const previousLevel = this.db.getComprehensionRepo()
      .get(this.activeRepoPath, this.activeQuiz.briefingId)?.level ?? 'unknown';

    let newLevel: ComprehensionLevel = previousLevel;
    if (correctCount === total) newLevel = 'confirmed';
    else if (correctCount === total - 1 && total >= 3) newLevel = 'explained';
    // ≤1 correct: stay where we are (no demotion).

    if (newLevel !== previousLevel) {
      this.observeComprehension(
        this.activeQuiz.briefingId,
        this.activeQuiz.label,
        newLevel,
        'question_asked',
      );
    }

    this.emit({
      type: 'quiz:result',
      payload: {
        briefingId: this.activeQuiz.briefingId,
        correct: correctCount,
        total,
        previousLevel,
        newLevel,
      },
    });
    this.activeQuiz = null;
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

  // ─────────────────────────────────────────────────────────────
  // grill_me: stateful interactive grill. The skill itself is a
  // one-shot trigger (returns visualPayload._action = 'start_grill');
  // the methods below run the actual loop. handleUtterance routes
  // user answers here while activeGrill is set.
  // ─────────────────────────────────────────────────────────────

  private async startGrillSession(opts: { topic: string; tone: 'coach' | 'strict' }): Promise<void> {
    if (!this.activeAnalyzer) {
      this.emit({ type: 'narration:greeting', payload: { text: "I need an active session to grill on. Try after the briefing finishes." } });
      return;
    }
    const repoPath = this.activeRepoPath || this.config.repoPath;
    // Pull project context to scope questions. Cheap — uses cached
    // project + module summaries we already have in the DB.
    const project = repoPath ? this.db.getContextCacheRepo().getProject(repoPath) : null;
    const modules = repoPath ? this.db.getContextCacheRepo().getModulesForRepo(repoPath) : [];
    const contextSummary = [
      project?.summary ?? '',
      ...modules.slice(0, 5).map(m => `${m.modulePath}: ${m.summary?.slice(0, 200) ?? ''}`),
    ].filter(Boolean).join('\n\n');

    const { startGrill } = await import('../intelligence/grill.js');
    try {
      const { session, firstQuestion } = await startGrill(this.activeAnalyzer.getClient(), {
        topic: opts.topic,
        context: contextSummary,
        tone: opts.tone,
      });
      this.activeGrill = session;
      // Ack + first question, chunked so the question reads naturally
      // (the lead becomes one short chunk, the question another).
      const lead = opts.tone === 'strict'
        ? `Alright. Let's grill you on ${opts.topic}.`
        : `Cool — let's see what you know about ${opts.topic}.`;
      await this.emitNarrationChunked(`${lead} ${firstQuestion}`);
    } catch (err: any) {
      this.emit({ type: 'narration:greeting', payload: { text: `Couldn't start the grill — ${err.message ?? 'unknown error'}.` } });
      this.activeGrill = null;
    }
  }

  private async handleGrillAnswer(answer: string): Promise<void> {
    if (!this.activeGrill || !this.activeAnalyzer) return;
    const { respondToAnswer } = await import('../intelligence/grill.js');
    try {
      const result = await respondToAnswer(this.activeAnalyzer.getClient(), this.activeGrill, answer);
      await this.emitNarrationChunked(result.spoken);
      // Update comprehension based on the running pattern. Strong
      // answers across consecutive turns earn a bump from 'heard' or
      // 'engaged' toward 'explained' / 'confirmed' on the topic.
      const lastEvals = this.activeGrill.turns.slice(-3).map(t => t.evaluation);
      const strongStreak = lastEvals.filter(e => e === 'strong').length;
      if (strongStreak >= 2) {
        // Two strong consecutive answers → bump comprehension. Reuse
        // the 'confirmed_phrase' reason since "answered confidently
        // under questioning" is the closest existing trigger; the
        // type isn't extensible from here without a wider refactor.
        this.observeComprehension(
          `topic/${this.activeGrill.topic.replace(/\s+/g, '-').toLowerCase()}`,
          this.activeGrill.topic,
          'explained',
          'confirmed_phrase',
          {},
        );
      }
      if (result.done) {
        this.activeGrill = null;
      }
    } catch (err: any) {
      this.emit({ type: 'narration:greeting', payload: { text: `Grill hit an error: ${err.message ?? 'unknown'}. Stopping.` } });
      this.activeGrill = null;
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

  /** Route a user utterance to a cached briefing when possible. Briefings serve
   *  in <100ms and skip the entire intent-classifier → LLM → TTS roundtrip. */
  private handleBriefingQuery(text: string): boolean {
    const repoPath = this.activeRepoPath;
    if (!repoPath) return false;

    const briefingId = this.resolveBriefingQuery(text, repoPath);
    if (!briefingId) return false;

    const briefing = this.db.getBriefingRepo().get(repoPath, briefingId);
    if (!briefing) return false;

    this.deliverBriefing(briefing, 'user_asked');
    return true;
  }

  // ─────────────────────────────────────────────────────────────
  // Navigator — stack-based conversational drill-down
  // ─────────────────────────────────────────────────────────────

  /** Emit a briefing AND push it on the navigator stack (if not already top). */
  private deliverBriefing(
    briefing: import('@tetherline/shared').Briefing,
    reason: 'user_asked' | 'dive_deeper' | 'tour_next' | 'resume_pop' | 'session_start',
    resumePrefix?: string,
  ): void {
    const top = this.navigator.peek();
    if (top?.briefingId !== briefing.id) {
      const check = this.navigator.checkPush(briefing.id);
      if (check.allowed) {
        this.navigator.push(frameFromBriefing(briefing, reason));
        this.emit({
          type: 'navigator:push',
          payload: {
            briefingId: briefing.id,
            depth: this.navigator.depth,
            breadcrumb: this.navigator.breadcrumb(),
            hint: check.hint,
          },
        });
      }
    }

    // Re-entry suppression: when the SAME briefing was just delivered
    // recently as part of a SESSION START (not user-asked, not a
    // tour-next that lands on this briefing for the first time, not
    // a navigator pop that already has its own resumePrefix UX),
    // abbreviate the opener instead of re-narrating the full thing.
    // The full briefing is a 30s+ monologue — playing it on every
    // session-start re-entry was the #1 voice-friction complaint.
    //
    // Scoped narrowly to `session_start` so:
    //   - user_asked / dive_deeper: user explicitly invited it, play full
    //   - tour_next: new area, briefing hasn't been delivered yet anyway
    //   - resume_pop: already shows resumePrefix ("Back up here"); don't
    //                 double-up with our abbreviation
    const repoPath = this.activeRepoPath || this.config.repoPath;
    const minutesSinceLast = repoPath
      ? this.db.getBriefingRepo().minutesSinceLastDelivery(repoPath, briefing.id)
      : null;
    let openerToEmit = briefing.opener;
    if (reason === 'session_start' && minutesSinceLast !== null) {
      if (minutesSinceLast < 30) {
        // Quick re-entry — skip the briefing, just acknowledge.
        openerToEmit = `Welcome back to ${briefing.title}. Where do you want to pick up?`;
      } else if (minutesSinceLast < 24 * 60) {
        // Same-day re-entry — keep just the first sentence + a re-engage prompt.
        const firstSentence = briefing.opener.split(/(?<=[.!?])\s+/)[0] ?? briefing.opener;
        openerToEmit = `${firstSentence} Ready to continue?`;
      }
      // ≥24 h → full opener (default). User likely wants the refresher.
    }

    this.emit({
      type: 'narration:briefing',
      payload: {
        briefingId: briefing.id,
        layer: briefing.layer,
        title: briefing.title,
        text: openerToEmit,
        estimatedSeconds: briefing.estimatedSeconds,
        talkingPoints: briefing.talkingPoints,
        children: briefing.children,
        parent: briefing.parent,
        cacheHit: true,
        resumePrefix,
      },
    });
    this.lastBriefingEmittedAt = Date.now();
    this.lastBriefingId = briefing.id;
    // Stamp the delivery so future re-entries can decide whether to
    // suppress / abbreviate.
    if (repoPath) {
      try { this.db.getBriefingRepo().markDelivered(repoPath, briefing.id); } catch { /* best-effort */ }
    }
    // Hearing a briefing only counts as 'heard'. To progress to 'explained'
    // / 'confirmed' the user has to actively engage — pass a quiz, ask a
    // follow-up, or confirm with a phrase. This is the depth lock: hearing
    // ≠ knowing, so a project-level briefing doesn't accidentally certify
    // the user on the modules underneath.
    this.observeComprehension(briefing.id, briefing.title, 'heard', 'briefing_delivered', {
      secondsHeard: briefing.estimatedSeconds,
    });
  }

  private reemitBriefing(repoPath: string, briefingId: string, resumePrefix: string): void {
    const briefing = this.db.getBriefingRepo().get(repoPath, briefingId);
    if (!briefing) return;
    this.emit({
      type: 'narration:briefing',
      payload: {
        briefingId: briefing.id,
        layer: briefing.layer,
        title: briefing.title,
        text: briefing.opener,
        estimatedSeconds: briefing.estimatedSeconds,
        talkingPoints: briefing.talkingPoints,
        children: briefing.children,
        parent: briefing.parent,
        cacheHit: true,
        resumePrefix: resumePrefix + '…',
      },
    });
    this.lastBriefingEmittedAt = Date.now();
  }

  /** Handle a navigator operation parsed from the utterance. Returns true if
   *  the utterance was consumed (and nothing else should process it). */
  private handleNavigatorOp(text: string): boolean {
    const op = resolveNavOp(text);
    if (op.kind === 'none') return false;
    const repoPath = this.activeRepoPath;
    if (!repoPath) return false;

    switch (op.kind) {
      case 'pop': {
        const popped = this.navigator.pop();
        if (!popped) return false;
        const current = this.navigator.peek();
        this.emit({
          type: 'navigator:pop',
          payload: {
            poppedBriefingId: popped.briefingId,
            currentBriefingId: current?.briefingId ?? null,
            depth: this.navigator.depth,
            breadcrumb: this.navigator.breadcrumb(),
          },
        });
        if (current) this.reemitBriefing(repoPath, current.briefingId, 'As I was saying');
        return true;
      }

      case 'pop_to_project': {
        const removed = this.navigator.popToProject();
        if (removed.length === 0) {
          // already at project — just restate the breadcrumb
          this.emit({
            type: 'navigator:breadcrumb',
            payload: {
              breadcrumb: this.navigator.breadcrumb(),
              depth: this.navigator.depth,
              frames: this.navigator.snapshot().map(f => ({ briefingId: f.briefingId, title: f.title, layer: f.layer })),
            },
          });
          return true;
        }
        this.emit({
          type: 'navigator:pop',
          payload: {
            poppedBriefingId: removed[0].briefingId,
            currentBriefingId: this.navigator.peek()?.briefingId ?? null,
            depth: this.navigator.depth,
            breadcrumb: this.navigator.breadcrumb(),
          },
        });
        const current = this.navigator.peek();
        if (current) this.reemitBriefing(repoPath, current.briefingId, 'Back to the top');
        return true;
      }

      case 'push_named': {
        const target = op.target;
        const moduleId = `module/${target}`;
        const conceptId = `concept/${target}`;
        const briefing =
          this.db.getBriefingRepo().get(repoPath, moduleId) ||
          this.db.getBriefingRepo().get(repoPath, conceptId);
        if (!briefing) return false; // fall through — other handlers may match
        this.deliverBriefing(briefing, 'user_asked');
        return true;
      }

      case 'push_code': {
        const target = op.target;
        // Stop-list: "walk me through the architecture" / "walk me
        // through the project" sound like code drills but they're nav
        // intents — defer to handleBriefingQuery so the architecture or
        // project briefing fires instead.
        const NAV_RESERVED = new Set([
          'architecture', 'project', 'overview', 'top', 'home',
          'structure', 'layout', 'codebase', 'repo', 'app',
        ]);
        if (NAV_RESERVED.has(target.toLowerCase())) return false;

        // Code drill is async (file IO + composer) — the navigator op
        // handler is sync, so we kick off the work and return true to
        // signal "I've taken this utterance." Errors get swallowed —
        // worst case the user just hears the existing briefing reread.
        (async () => {
          try {
            const resolved = await this.resolveCodeTarget(repoPath, target);
            if (!resolved) return;
            const { composeCodeBriefing } = await import('../briefing/code-composer.js');
            const result = composeCodeBriefing({
              repoPath,
              filePath: resolved.filePath,
              symbol: resolved.symbol,
            });
            if (!result) return;
            this.deliverBriefing(result.briefing, 'user_asked');

            // Stream the code chunks WITH their line ranges so the
            // CodePanel can advance the highlight as Hermes speaks
            // each one. Without this, the panel just shows the file —
            // the "walk line by line" promise wouldn't be visible.
            if (result.chunks.length > 0) {
              const streamId = `code-${Date.now()}`;
              for (let i = 0; i < result.chunks.length; i++) {
                const c = result.chunks[i];
                this.emit({
                  type: 'narration:stream_chunk',
                  payload: {
                    streamId,
                    seq: i,
                    text: c.voiceLine,
                    isFinal: i === result.chunks.length - 1,
                    range: c.range,
                    filePath: resolved.filePath,
                  },
                });
              }
            }
          } catch (err) {
            // best-effort — fall through silently
          }
        })();
        return true;
      }

      case 'dive_deeper': {
        const current = this.navigator.peek();
        if (!current) return false;
        const currentBriefing = this.db.getBriefingRepo().get(repoPath, current.briefingId);
        if (!currentBriefing || currentBriefing.children.length === 0) return false;
        for (const childId of currentBriefing.children) {
          const child = this.db.getBriefingRepo().get(repoPath, childId);
          if (child) {
            this.deliverBriefing(child, 'dive_deeper');
            return true;
          }
        }
        return false;
      }

      case 'breadcrumb': {
        this.emit({
          type: 'navigator:breadcrumb',
          payload: {
            breadcrumb: this.navigator.breadcrumb(),
            depth: this.navigator.depth,
            frames: this.navigator.snapshot().map(f => ({ briefingId: f.briefingId, title: f.title, layer: f.layer })),
          },
        });
        return true;
      }

      case 'resume': {
        const current = this.navigator.peek();
        if (!current) return false;
        this.reemitBriefing(repoPath, current.briefingId, 'Picking up where we left off');
        return true;
      }
    }
    return false;
  }

  /** Public getter for tests + dev API. */
  getNavigatorSnapshot() {
    return {
      depth: this.navigator.depth,
      frames: this.navigator.snapshot(),
      breadcrumb: this.navigator.breadcrumb(),
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Voice floor control — interruption handling.
  //
  // Proven-product pattern (ChatGPT Realtime, Gemini Live, Pi):
  //   - When user starts speaking, flush TTS queue + halt server-side
  //     narration generation.
  //   - While user holds the floor, suppress all outbound narration.
  //   - After user stops, wait a small silence window before resuming.
  //   - Emit trace events so the measurement layer can score every exchange.
  // ─────────────────────────────────────────────────────────────
  markUserSpeakingStarted(): void {
    this.userSpeaking = true;
    this.userStoppedAt = null;
    // Note: we emit a tts.queue_flush trace event immediately. The real queue
    // flush is frontend-side (audio element clear) — the backend signals via
    // narration:text with empty text, or by simply dropping any pending
    // segments. For now, the trace records the semantic "flush point" so
    // measurements are accurate.
    const tr = getTraceRecorder();
    tr?.emit({ kind: 'tts.queue_flush', sessionId: this.context.sessionId || null, payload: {} });
  }

  markUserSpeakingStopped(): void {
    this.userSpeaking = false;
    this.userStoppedAt = Date.now();
  }

  /** True if the server should currently SUPPRESS outbound narration. */
  private shouldSuppressNarration(): boolean {
    if (this.userSpeaking) return true;
    if (this.userStoppedAt !== null && Date.now() - this.userStoppedAt < this.POST_USER_SILENCE_MS) {
      return true;
    }
    return false;
  }

  getVoiceFloorState() {
    return {
      userSpeaking: this.userSpeaking,
      suppressed: this.shouldSuppressNarration(),
      msSinceUserStopped: this.userStoppedAt !== null ? Date.now() - this.userStoppedAt : null,
    };
  }

  /** Test-only escape hatch: fire a narration:greeting right now. Flows
   *  through the gated `emit()` wrapper, so it's dropped if the user holds
   *  the floor. Used by voice-measurement scenarios to exercise the gate. */
  forceEmitNarration(text: string): void {
    this.emit({ type: 'narration:greeting', payload: { text } });
  }

  // ─────────────────────────────────────────────────────────────
  // Comprehension — passive confidence tracking
  // ─────────────────────────────────────────────────────────────

  /** Derive a comprehension layer from a briefing id. */
  /** Pull comprehension items the user got to engaged-or-better in prior
   *  sessions, annotated with commits-since-last-touch so the user can
   *  see what's drifted. Used for the "pick up where you left off"
   *  surface on session start. */
  private async collectRecallItems(repoPath: string, currentSessionId: string): Promise<Array<{
    itemId: string;
    label: string;
    layer: string;
    level: 'unknown'|'mentioned'|'heard'|'engaged'|'explained'|'confirmed';
    commitsSinceLastTouch: number;
  }>> {
    try {
      const items = this.db.getComprehensionRepo().getAll(repoPath);
      const RICH_LEVELS = new Set(['engaged', 'explained', 'confirmed']);
      const candidates = items
        .filter((it: any) => RICH_LEVELS.has(it.level))
        .filter((it: any) => it.lastSessionId && it.lastSessionId !== currentSessionId)
        .slice(0, 5);
      if (candidates.length === 0) return [];

      // For each item, count commits that touched its module/file since
      // last touch. One git log call per item — bounded by the slice cap.
      const simpleGit = (await import('simple-git')).default;
      const git = simpleGit(repoPath);
      const out: Array<{ itemId: string; label: string; layer: string; level: any; commitsSinceLastTouch: number }> = [];
      for (const it of candidates) {
        const since = it.lastTouchedAt;
        const filter = this.itemPathFilter(it.itemId, repoPath);
        let commits = 0;
        try {
          const log = await git.raw([
            'log', `--since=${since}`, '--pretty=format:%H',
            ...(filter ? ['--', filter] : []),
          ]);
          commits = log.split('\n').filter(Boolean).length;
        } catch { /* graceful zero */ }
        out.push({
          itemId: it.itemId, label: it.label, layer: it.layer,
          level: it.level, commitsSinceLastTouch: commits,
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Map a comprehension item id to a git path filter so we can count
   *  commits scoped to its area. Returns null for items that cover the
   *  whole repo (project / arch). */
  private itemPathFilter(itemId: string, _repoPath: string): string | null {
    if (itemId === 'project' || itemId === 'arch/root') return null;
    if (itemId.startsWith('module/')) {
      const modName = itemId.slice('module/'.length);
      // Best-effort: a module named "auth" → filter on "auth/" path.
      // For workspace-style modules under packages/* we'd need the full
      // prefix — fall back to no filter rather than mis-count.
      return modName.includes('/') ? modName : `${modName}/`;
    }
    if (itemId.startsWith('file/')) return itemId.slice('file/'.length);
    if (itemId.startsWith('code/')) {
      const filePath = itemId.slice('code/'.length).split(':')[0];
      return filePath;
    }
    return null;
  }

  /** Resolve a code-drill target ("capture", "manager.ts", "handleQuestion")
   *  to a concrete file + optional symbol. Strategy:
   *   1. Direct file path (contains a slash or has a known extension) →
   *      use as-is, let composer pick the first symbol.
   *   2. Symbol name (no path separator) → grep cached file list for
   *      `function symbol`, `class symbol`, `const symbol =` etc.
   *   3. Bare filename (e.g. "manager.ts") → match by basename.
   */
  private async resolveCodeTarget(
    repoPath: string,
    target: string,
  ): Promise<{ filePath: string; symbol?: string } | null> {
    const fs = await import('fs');
    const path = await import('path');

    // 1. Direct path? (contains "/" or a known code extension at the end)
    const looksLikePath = target.includes('/') || /\.(ts|tsx|js|jsx|py|go|rs|java|kt)$/.test(target);
    if (looksLikePath) {
      const full = path.join(repoPath, target);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return { filePath: target };
      }
    }

    // 2 + 3. Search the cached file list. Cheap because it's already in DB.
    const cachedFiles = this.db.getContextCacheRepo().getFilesForRepo(repoPath);
    if (cachedFiles.length === 0) return null;

    // 3. Bare filename match (e.g. "manager.ts" → "packages/backend/src/session/manager.ts").
    const byBasename = cachedFiles.find(f => path.basename(f.filePath) === target);
    if (byBasename) return { filePath: byBasename.filePath };

    // 2. Symbol grep. We avoid reading every file — only check candidates
    // whose role looks code-like (entry, route, component, model, utility).
    const candidates = cachedFiles
      .filter(f => /\.(ts|tsx|js|jsx|py|go|rs)$/.test(f.filePath))
      .sort((a, b) => (b.connectivity ?? 0) - (a.connectivity ?? 0))
      .slice(0, 80); // bound the IO

    // Case-insensitive — voice utterances normalize casing; the
    // composer also matches case-insensitively when extracting the
    // symbol from the source.
    const symbolRe = new RegExp(
      `(?:function|class|interface|type|const|def|func|fn)\\s+${escapeForRegex(target)}\\b`,
      'i',
    );
    for (const cand of candidates) {
      try {
        const content = fs.readFileSync(path.join(repoPath, cand.filePath), 'utf8');
        if (symbolRe.test(content)) {
          return { filePath: cand.filePath, symbol: target };
        }
      } catch { /* skip unreadable */ }
    }
    return null;
  }

  private layerFromBriefingId(briefingId: string): ComprehensionItemLayer {
    if (briefingId === 'project') return 'project';
    if (briefingId === 'arch/root' || briefingId.startsWith('arch/')) return 'architecture';
    if (briefingId.startsWith('module/')) return 'module';
    if (briefingId.startsWith('file/')) return 'file';
    if (briefingId.startsWith('concept/')) return 'concept';
    return 'project';
  }

  /** Observe a transition for a comprehension item, guarded by per-item
   *  cooldown. Emits `comprehension:updated` when the level actually moves. */
  private observeComprehension(
    itemId: string,
    label: string,
    proposedLevel: ComprehensionLevel,
    reason: 'briefing_delivered' | 'question_asked' | 'listened_through' | 'confirmed_phrase' | 'stale',
    opts: { secondsHeard?: number; questionsAsked?: number } = {},
  ) {
    const repoPath = this.activeRepoPath;
    if (!repoPath) return;

    const now = Date.now();
    const lastTouch = this.lastComprehensionTouchAt.get(itemId) ?? 0;
    // Cooldown applies to passive signals only — confirmation phrases,
    // staleness degrade, and quiz scoring are all intentional and must
    // always update.
    const bypassCooldown =
      reason === 'confirmed_phrase' ||
      reason === 'stale' ||
      reason === 'question_asked';
    if (!bypassCooldown && now - lastTouch < this.COMPREHENSION_COOLDOWN_MS) {
      return; // cooldown — skip
    }
    this.lastComprehensionTouchAt.set(itemId, now);

    const repo = this.db.getComprehensionRepo();
    const before = repo.get(repoPath, itemId);
    const layer = this.layerFromBriefingId(itemId);
    const item = repo.observe(repoPath, itemId, layer, label, proposedLevel, {
      sessionId: this.context.sessionId,
      narrationSecondsHeard: opts.secondsHeard,
      questionsAsked: opts.questionsAsked,
    });

    if (!before || before.level !== item.level) {
      this.emit({
        type: 'comprehension:updated',
        payload: {
          itemId: item.itemId,
          label: item.label,
          layer: item.layer,
          level: item.level,
          previousLevel: (before?.level ?? 'unknown') as ComprehensionLevel,
          reason,
        },
      });
    }
  }

  /** Attempt to match a confirmation phrase against the last briefing. Only
   *  fires within CONFIRMATION_WINDOW_MS of the briefing being delivered. */
  private tryConfirmLastBriefing(text: string): boolean {
    if (!this.lastBriefingId || !this.lastBriefingEmittedAt) return false;
    const elapsed = Date.now() - this.lastBriefingEmittedAt;
    if (elapsed > this.CONFIRMATION_WINDOW_MS) return false;
    if (!isConfirmationPhrase(text)) return false;

    const repoPath = this.activeRepoPath;
    if (!repoPath) return false;

    const briefing = this.db.getBriefingRepo().get(repoPath, this.lastBriefingId);
    const label = briefing?.title ?? this.lastBriefingId;
    this.observeComprehension(this.lastBriefingId, label, 'confirmed', 'confirmed_phrase');
    return true;
  }

  /** Map a user utterance to a briefing id. Returns null if none matches. */
  private resolveBriefingQuery(text: string, repoPath: string): string | null {
    const t = text.trim().toLowerCase();

    // Project-level asks
    const projectPatterns = [
      /\bwhat (is|does) (this|the) (project|app|repo|codebase)/,
      /\bwhat(?:'s| is) (it|this|the project) about\b/,
      /\bwhat does this (do|do\?)\b/,
      /\btell me about (this|the project|the codebase|the repo)\b/,
      /\bgive me (an |a |the )?(overview|summary)\b/,
      /\bwhat am i looking at\b/,
    ];
    if (projectPatterns.some(p => p.test(t))) return 'project';

    // Architecture asks
    const architecturePatterns = [
      /\b(walk me through|show me|tell me about) the (architecture|structure|layout)\b/,
      /\bwhat does the (architecture|structure) look like\b/,
      /\b(high[\s-]?level )?(architecture|structure)\b.*(overview|tour)/,
      /^architecture\b/,
    ];
    if (architecturePatterns.some(p => p.test(t))) return 'arch/root';

    // Module / topic asks: "tell me about X" / "what's the X module" / "how does X work"
    const moduleAsk =
      /^(?:tell me about|show me|what(?:'s| is) the|how does|what does) ([\w-]+)(?:\s+(?:module|work|do))?[\s?.!]*$/.exec(t)
      || /^(?:let's )?(?:look|talk) about ([\w-]+)/.exec(t);
    if (moduleAsk) {
      const target = moduleAsk[1];
      if (target && target !== 'this' && target !== 'it') {
        // Prefer an exact module briefing; fall back to concept if available.
        const moduleId = `module/${target}`;
        if (this.db.getBriefingRepo().get(repoPath, moduleId)) return moduleId;
        const conceptId = `concept/${target}`;
        if (this.db.getBriefingRepo().get(repoPath, conceptId)) return conceptId;
      }
    }

    return null;
  }

  private async handleUtterance(text: string): Promise<void> {
    getTraceRecorder()?.emit({
      kind: 'utterance.received',
      sessionId: this.context.sessionId || null,
      payload: {
        text,
        phase: this.state.phase,
        areaName: this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex]?.name : null,
      },
    });

    // grill_me is in progress — the user's utterance is an ANSWER to
    // the current grill question, not a fresh request. Route to the
    // grill loop, which will evaluate and either ask the next question
    // or wrap up. The skill classifier doesn't run while a grill is
    // active so the user can answer naturally without their answer
    // accidentally triggering a different skill.
    if (this.activeGrill && !this.activeGrill.done) {
      await this.handleGrillAnswer(text);
      return;
    }

    // During PROPOSAL phase, handle utterances with proposal-specific logic
    if (this.state.phase === 'PROPOSAL') {
      if (this.handleProposalUtterance(text)) return;
      // If the utterance is clearly a real question (>4 words and not a
      // short confirmation), accept the proposal silently AND route the
      // question through the normal pipeline so it actually gets answered.
      // The old behavior — fall through to acceptProposal() with a stock
      // "Go ahead." — swallowed substantive questions like "tell me what
      // X does" because the user happened to be in PROPOSAL phase.
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      if (wordCount > 4) {
        this.acceptProposal();
        // After acceptProposal the phase has changed; fall through to the
        // normal handleUtterance pipeline below by recursing.
        await this.handleUtterance(text);
        return;
      }
      this.acceptProposal();
      return;
    }

    // Fast-path #0: confirmation phrases ("got it", "makes sense") — tracked
    // against the most recent briefing for comprehension. Guarded: only fires
    // within CONFIRMATION_WINDOW_MS of the briefing being emitted.
    if (this.tryConfirmLastBriefing(text)) {
      // Confirmation phrases are not a navigation; let them also pass through
      // to quickCommand / intent classifier in case they meant "resume" or
      // similar. But for now, we consume them so the AI doesn't double-respond.
      return;
    }

    // Fast-path #1: Navigator stack operations. "go back", "back to the overview",
    // "tell me about X", "deeper", "where are we" — all resolved without an LLM
    // call. Runs FIRST so nav phrases take precedence over the legacy
    // quickCommand matcher (which would route "go back" to the linear previous
    // command that predated the stack).
    if (this.handleNavigatorOp(text)) return;

    // Fast-path #2: well-known navigation/action phrases (skip, pause, resume)
    // that aren't part of the Navigator vocabulary.
    const handled = this.handleQuickCommand(text);
    if (handled) return;

    // Fast-path #3: briefing queries answered from cache ( <100ms ) — handles
    // project/architecture asks and any named target the nav vocab didn't catch.
    if (this.handleBriefingQuery(text)) return;

    // If no intent classifier available, fall back to treating it as a question
    if (!this.intentClassifier) {
      this.handleQuestion(text);
      return;
    }

    // Build context string for the classifier
    const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
    const contextStr = `Phase: ${this.state.phase}. Area: ${currentArea?.name ?? 'none'}. Areas: ${this.areas.map(a => a.name).join(', ')}.`;

    const classification = await this.intentClassifier.classify(text, contextStr);

    getTraceRecorder()?.emit({
      kind: 'intent.classified',
      sessionId: this.context.sessionId || null,
      payload: {
        text,
        skillName: classification.skillName,
        navigationCommand: classification.navigationCommand ?? null,
        params: classification.params,
        confidence: classification.confidence,
      },
    });

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

    // Explicit "no skill matches" → route to the general conversational
    // handler. This is the escape hatch that prevents force-fitting
    // creative/off-menu requests ("write me a poem", "what if...", "no
    // try again differently") into the nearest available skill.
    // handleQuestion sends the utterance + project context + recent
    // turns to the LLM and emits the reply naturally.
    if (classification.skillName === 'none') {
      // Pass the classifier's extracted params through so the
      // conversational handler can honor "format: poem, lines: two,
      // length: 10 words" the same way summarize does for its skill.
      this.handleQuestion(text, classification.params);
      return;
    }

    // Low confidence -- also route to general conversation. The
    // classifier was told to prefer 'none' when uncertain, but when it
    // still hedges below 0.7 we trust the conversational handler over a
    // forced skill rather than asking for clarification (the user just
    // told us what they want; making them rephrase is bad UX).
    if (classification.confidence < 0.7) {
      this.handleQuestion(text, classification.params);
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
          contextComposer: this.contextComposer ?? undefined,
        },
        params,
      );

      this.emit({ type: 'skill:result', payload: { result } });

      // Special handling: grill_me kicks off a stateful interactive
      // grill. The skill itself returns no narration; the manager
      // generates the FIRST question via grill.ts and parks the
      // session in `activeGrill` mode so subsequent utterances are
      // routed to the grill loop instead of being re-classified.
      const action = (result.visualPayload as Record<string, unknown>)?._action;
      if (result.skillName === 'grill_me' && action === 'start_grill') {
        await this.startGrillSession(result.visualPayload as { topic: string; tone: 'coach' | 'strict' });
        return;
      }

      // Speak the skill's narration. Was emitting as a single
      // narration:greeting which hits the synchronous TTS path —
      // a 250-word answer rendered as one Kokoro blob sounded robotic,
      // couldn't be interrupted mid-sentence, and overlapped with any
      // concurrent stream_chunk audio. Chunking it via
      // chunkAnswerForStreaming gives the same paced playback as
      // handleQuestion: sentence-sized clips queued sequentially,
      // each interruptible on PTT, with a single coherent voice.
      if (result.narration && result.narration.trim().length > 0) {
        await this.emitNarrationChunked(result.narration);
      }

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

      // After skill completes, check in (once per deviation) — but ONLY
      // if the skill itself was silent. Skills that produce narration
      // (summarize, explain, critique, teach) have already spoken; firing
      // a nudge here races them through the orchestrator's 250ms greeting
      // coalesce, and the user hears the nudge instead of the answer.
      // The nudge exists to fill silence, not to talk over the answer.
      const skillWasSilent = !result.narration || result.narration.trim().length === 0;
      if (skillWasSilent && this.tourPlan?.isInDeviation() && !this.tourPlan.hasCheckedIn()) {
        this.tourPlan.markDeviationCheckedIn();
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
    if (this.entryMode === 'explore') {
      // Explore mode: show architecture and wait. User leads.
      this.setVisualLayer(3);
      this.setState({ phase: 'OVERVIEW' });
      this.emit({
        type: 'narration:greeting',
        payload: { text: `Go ahead.` },
      });
    } else if (this.entryMode === 'full_walkthrough') {
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

  /** Handle user utterance during PROPOSAL phase. Returns true if handled.
   *
   *  The matchers below previously used unanchored `^token` regexes, which
   *  let "okay, in under 10 words..." match as an ack and silently
   *  swallowed the real question. Now every matcher requires the trigger
   *  phrase to be the WHOLE utterance (or at most a couple trailing
   *  words) — anything longer or with substantive content trailing the
   *  ack falls through, so the caller's "wordCount > 4 → accept-and-
   *  recurse" path can route it to QA. */
  private handleProposalUtterance(text: string): boolean {
    const lower = text.toLowerCase().trim().replace(/[.!?,;]+$/, '');
    const wordCount = lower.split(/\s+/).filter(Boolean).length;

    // "yes" / "sounds good" / "let's go" → accept. Match only when the
    // utterance IS an ack (≤3 words AND end-anchored). "okay" passes;
    // "okay, in under 10 words tell me what this project does" does not.
    const ACK_PATTERN = /^(yes|yeah|yep|sure|sure thing|sounds? good|let'?s go|ok|okay|go ahead|start|begin|begin tour|looks? good|do it|please|alright|all right)$/;
    if (wordCount <= 3 && ACK_PATTERN.test(lower)) {
      this.acceptProposal();
      return true;
    }

    // "just the highlights" → set condensed flag and accept. Require the
    // condensed trigger to be a meaningful share of the utterance
    // (≤4 words) so it doesn't match a 12-word question that happens to
    // contain "brief".
    const CONDENSED_PATTERN = /^(just )?(the )?(highlights?|brief(?: version)?|quick(?: version)?|short(?: version)?|condensed|summary only|skim|tldr)$/;
    if (wordCount <= 4 && CONDENSED_PATTERN.test(lower)) {
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

    // "focus on [X]" → filter to matching area and accept. The match
    // must start the utterance (it's a directive, not a phrase that
    // might appear inside a question).
    const focusMatch = lower.match(/^focus (?:on )?(.+)$/);
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

    // "skip" → go to wrap up. Standalone command only.
    if (/^skip( (it|this|the tour))?$/.test(lower)) {
      this.setState({ phase: 'WRAP_UP' });
      return true;
    }

    // Check if user named a specific area as a SHORT request to start
    // there (e.g. "core" / "tell me about core"). Require ≤6 words so
    // a 20-word question like "summarize what the core module does"
    // doesn't hijack into proposal acceptance — that should go through
    // the normal QA pipeline.
    if (wordCount <= 6) {
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

/** Whisper / browser STT commonly hallucinates these short fragments on
 *  silence or background noise. Treating them as questions makes the AI
 *  generate "I'm here, ready to help!" filler — which the user explicitly
 *  asked us to never do during quiet moments. Backend filter mirrors the
 *  frontend one in `useVoiceInput.ts` (defense in depth). */
const TRANSCRIPTION_NOISE_PHRASES = new Set([
  'you', '.', 'thanks for watching', 'thanks for watching!',
  'thank you', 'thank you.', 'thank you!', 'thanks', 'thanks.',
  'bye', 'bye.', 'bye!', 'goodbye', 'goodbye.',
  'subscribe', 'please subscribe', 'subscribe!',
  'silence', '[silence]', 'background noise', '[music]',
  'um', 'uh', 'mm', 'mhm', 'hm', 'oh',
]);

export function isLikelyTranscriptionNoise(text: string): boolean {
  const cleaned = (text ?? '').trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (cleaned.length < 3) return true;
  if (TRANSCRIPTION_NOISE_PHRASES.has(cleaned)) return true;
  return false;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
