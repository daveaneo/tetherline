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
import { getTraceRecorder } from '../dev/trace.js';
import { scoreQuizAnswer } from '../intelligence/quiz.js';
import type { LLMStreamHandle } from '../intelligence/llm/types.js';
import { getDefaultLLMAdapter } from '../intelligence/llm/index.js';
import { classifyArtifact, extractFencedArtifacts, type ExtractedArtifact } from '../intelligence/fence-extract.js';
import { narrationMentionsOnly } from '../intelligence/flow-validate.js';
import { FLOW_BRIDGE_LINE } from './answer-streamer.js';
import { applyComprehension } from '@tetherline/shared';
import type { DiagramRow } from '../db/repositories/diagram-cache-repo.js';
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
  /** Grounding retriever — live file contents for Q&A prompts. */
  private retriever: import('../intelligence/retriever.js').Retriever | null = null;
  /** Alias→node map for narration anchors + the visual dispatcher. */
  private anchorIndex: import('../intelligence/anchor-index.js').AnchorIndex | null = null;
  /** The diagram scope the FRONTEND is currently showing (mirrored via
   *  the diagram:scope client event). 'project' at the root. */
  private clientScope = 'project';
  /** Idempotency guard: a duplicate session:start (double-click, voice
   *  dialog double-fire, WS reconnect replay) must not run the whole
   *  start pipeline twice (double opener, double briefing.push). */
  private startGuard: { repoPath: string; startedAt: number; inFlight: boolean } | null = null;
  /** Session-open narration stream: greeting → opener → updates recap →
   *  proposal all share ONE streamId so the frontend queue APPENDS
   *  (a second streamId would wipe still-queued opener chunks). */
  private openStreamId: string | null = null;
  private openStreamSeq = 0;
  /** Set after an anchors-only answer offered "want me to dig through the
   *  code?" — an affirmative next utterance escalates to the agentic path. */
  private pendingEscalation: { question: string; expiresAt: number } | null = null;
  private navigator = new Navigator();
  /** Timestamp of the last narration:briefing emit — lets us derive a rough
   *  resume position when the user interrupts mid-speech. */
  private lastBriefingEmittedAt: number | null = null;
  private lastBriefingId: string | null = null;
  /** The flow most recently surfaced alongside a module briefing + the
   *  canonical item ids of its stages. When that briefing is marked seen (its
   *  narration — which now describes every stage — finished playing), the
   *  stages are marked seen too, so the flow view shows real Seen%. */
  private lastSurfacedFlow: { briefingId: string; stages: Array<{ itemId: string; label: string }> } | null = null;
  /** Whether the user currently holds the conversational floor. When true, the
   *  server suppresses outbound narration — prevents AI-on-user overlap. */
  private userSpeaking = false;
  /** After the user stops speaking, the AI waits this many ms before its next
   *  audio output. Blocks the "AI jumped in too fast" pattern. Tunable. */
  private readonly POST_USER_SILENCE_MS = 600;
  private userStoppedAt: number | null = null;
  /** Rolling Q&A history threaded into the system prompt for follow-up
   *  coherence ("what about it?" needs to know what "it" was). Capped to
   *  the last few turns so prompt size stays small. */
  private qaTurns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private readonly QA_HISTORY_MAX = 6;
  /** Per-session answer-length preference. Sticks until the user changes
   *  it ("shorter" / "more detail"). The QA scaffold uses this to steer
   *  the LLM's output length on every answer. */
  private depthTier: import('../intelligence/depth-modifiers.js').DepthTier = 'normal';
  /** Previous spoken ack — pickAck never repeats it twice in a row. */
  private lastAck: string | null = null;
  /** Set when an answer was truncated at the sentence cap. A bare "tell me
   *  more" within 2 minutes re-asks this question at the deep tier (the
   *  aborted stream's tail was never generated — re-asking is the only
   *  correct source for the longer answer). */
  private lastTruncated: { question: string; params: Record<string, string>; at: number } | null = null;
  /** Cooldown per comprehension item — same item can only transition once every
   *  30s, protects against chatty transcripts double-counting. */
  private readonly COMPREHENSION_COOLDOWN_MS = 30_000;
  private lastComprehensionTouchAt = new Map<string, number>();
  /** The stream id minted for the answer to the user's MOST RECENT utterance.
   *  Chunks of this stream are HELD (not dropped) when the floor gate is
   *  closed — they're the reply to what the user just said, led by the seq-0
   *  ack, and dropping them silently eats the ack (live bug 2026-06-09). */
  private currentTurnStreamId: string | null = null;
  /** The briefingId of a cache-fast briefing that is the DIRECT response to
   *  the user's most recent utterance ("tell me about core" → module/core).
   *  Such a briefing is HELD like the turn's stream ack instead of dropped —
   *  otherwise the answer the user asked for is swallowed by the post-silence
   *  window (live bug 2026-06-10). Proactive briefings (session_start /
   *  tour_next) leave this null so they still drop when talked over. */
  private currentTurnBriefingId: string | null = null;
  /** Bumped on every new turn / barge-in. Async fast paths (code drill) that
   *  emit narration after an await capture the epoch and bail if the turn was
   *  superseded, so a stale code-walk can't claim the live turn's stream. */
  private turnEpoch = 0;
  /** Narration held while the user holds the floor, released in order when
   *  the floor opens. Only ever holds the current turn's response (stream
   *  chunks or a direct-response briefing). */
  private pendingFloorNarration: Array<{ event: ServerEvent; queuedAt: number }> = [];
  private floorReleaseTimer: NodeJS.Timeout | null = null;

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
    // 'narration:stream_chunk' carries AI speech too and is counted as a
    // tts.emit by traceNarrationEvent — it MUST be gated like the rest,
    // or chunked narration talks over the user (the floor-gate hole
    // that regressed emitsDuringUserSpeech to 6/12 once chunked
    // streaming became the primary narration path).
    'narration:stream_chunk',
    'qa:answer_chunk',
  ]);

  constructor(
    private db: Database,
    private config: AppConfig,
    emit: (event: ServerEvent) => void,
  ) {
    this.rawEmit = emit;
  }

  /** Gated emit — while the user holds the floor, AI speech events are
   *  HELD if they belong to the current turn's answer stream (the reply to
   *  what the user just said, led by the seq-0 ack) and DROPPED otherwise
   *  (greetings, briefings, stale streams — proactive content the user
   *  talked over). Held chunks are released in order once the floor opens.
   *  All other events (state changes, errors, progress) flow through.
   *
   *  Gate is disabled when `TETHERLINE_DISABLE_FLOOR_SUPPRESSION=1` so we can
   *  measure the pre-fix baseline reproducibly. */
  private emit(event: ServerEvent): void {
    const gateDisabled = process.env.TETHERLINE_DISABLE_FLOOR_SUPPRESSION === '1';
    const suppressed = !gateDisabled && this.shouldSuppressNarration();
    // Ordering invariant: any un-suppressed emit drains held chunks FIRST,
    // so a held seq-0 ack can never arrive after a later seq of the same
    // stream. The release timer is just the backstop for when no further
    // emits happen (exactly the lone-ack situation).
    if (!suppressed && this.pendingFloorNarration.length > 0) {
      this.flushPendingFloorNarration();
    }
    if (suppressed && this.NARRATION_EVENT_TYPES.has(event.type)) {
      const streamId = (event.payload as { streamId?: string }).streamId;
      const briefingId = (event.payload as { briefingId?: string }).briefingId;
      // The current turn's RESPONSE — a stream-chunk ack/answer OR the
      // cache-fast briefing the user just asked for — is held, not dropped.
      const isTurnResponse =
        (event.type === 'narration:stream_chunk' &&
          streamId !== undefined &&
          streamId === this.currentTurnStreamId) ||
        (event.type === 'narration:briefing' &&
          briefingId != null &&
          briefingId === this.currentTurnBriefingId);
      if (isTurnResponse) {
        this.pendingFloorNarration.push({ event, queuedAt: Date.now() });
        getTraceRecorder()?.emit({
          kind: 'tts.hold',
          sessionId: this.context.sessionId || null,
          payload: { eventType: event.type, streamId: streamId ?? null, briefingId: briefingId ?? null, seq: (event.payload as { seq?: number }).seq ?? null },
        });
        return;
      }
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

  /** Release narration held during the floor closure, in arrival order.
   *  Re-checks suppression (a speaking_started may have raced the timer);
   *  bails if still closed — markUserSpeakingStopped re-arms the timer. */
  private flushPendingFloorNarration(): void {
    if (this.pendingFloorNarration.length === 0) return;
    const gateDisabled = process.env.TETHERLINE_DISABLE_FLOOR_SUPPRESSION === '1';
    if (!gateDisabled && this.shouldSuppressNarration()) return;
    const pending = this.pendingFloorNarration;
    this.pendingFloorNarration = [];
    const heldForMs = Date.now() - pending[0].queuedAt;
    for (const { event } of pending) {
      this.traceNarrationEvent(event);
      this.rawEmit(event);
    }
    getTraceRecorder()?.emit({
      kind: 'tts.release',
      sessionId: this.context.sessionId || null,
      payload: { count: pending.length, heldForMs },
    });
  }

  /** Drop held narration — the user spoke again, so the held turn is stale
   *  (a fresh utterance with a fresh ack is coming). */
  private discardPendingFloorNarration(reason: string): void {
    if (this.pendingFloorNarration.length === 0) return;
    const count = this.pendingFloorNarration.length;
    this.pendingFloorNarration = [];
    getTraceRecorder()?.emit({
      kind: 'tts.discard_pending',
      sessionId: this.context.sessionId || null,
      payload: { count, reason },
    });
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
      case 'command:force_skill': {
        // Dev-only: bypass the intent classifier and run a named skill
        // directly with given params. Lets us fire identical input at
        // two skills and diff their real narration (explain vs teach,
        // etc.) without the classifier collapsing it to one route.
        const forcedArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
        if (!this.activeAnalyzer) {
          this.emit({ type: 'error', payload: { code: 'SKILL_FAILED', message: 'No active analyzer — start a session first', recoverable: true } });
          break;
        }
        this.executeSkillWithDeviation(
          event.payload.skillName as SkillName,
          event.payload.params ?? {},
          forcedArea,
        ).catch(err => {
          this.emit({ type: 'error', payload: { code: 'SKILL_FAILED', message: err.message ?? 'Forced skill failed', recoverable: true } });
        });
        break;
      }
      case 'command:toggle_mode':
        this.handleModeToggle(event.payload.mode, event.payload.enabled);
        break;
      case 'command:export':
        this.handleExport(event.payload.format);
        break;
      case 'audio:segment_finished':
        this.handleSegmentFinished(event.payload.segmentId);
        break;
      case 'diagram:scope':
        // Frontend mirrors its local scope so dispatchVisual classifies
        // DESCEND/ASCEND/LATERAL against what the user actually sees.
        if (/^(project$|module\/|file\/|concept\/)/.test(event.payload.scope)) {
          this.clientScope = event.payload.scope;
        }
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

  /** Chunk + emit session-open narration on the single open stream. */
  private async emitOpenChunks(text: string, isFinal: boolean): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && !isFinal) return;
    if (!this.openStreamId) {
      this.openStreamId = `open-${this.context.sessionId || Date.now()}`;
      this.openStreamSeq = 0;
    }
    const { chunkAnswerWithAnchors } = await import('../intelligence/sentence-chunker.js');
    const nodeLabels = await this.knownNodeLabels();
    const tagged = trimmed ? chunkAnswerWithAnchors(trimmed, nodeLabels) : [];
    if (tagged.length === 0 && isFinal) tagged.push({ text: trimmed || ' ', referencedNodes: [] });
    for (let i = 0; i < tagged.length; i++) {
      this.emit({
        type: 'narration:stream_chunk',
        payload: {
          streamId: this.openStreamId,
          seq: this.openStreamSeq++,
          text: tagged[i].text,
          isFinal: isFinal && i === tagged.length - 1,
          referencedNodes: tagged[i].referencedNodes,
        },
      });
    }
  }

  private async startSession(repoPath: string, sinceDays?: number) {
    // Idempotency: ignore a duplicate start for the same repo while one is
    // in flight (or freshly active). The client re-syncs from state.
    const effectiveGuardPath = repoPath || this.config.repoPath;
    const activePhases = new Set(['ANALYZING', 'PROPOSAL', 'PREVIOUSLY_ON', 'HEATMAP', 'OVERVIEW']);
    if (this.startGuard
      && this.startGuard.repoPath === effectiveGuardPath
      && Date.now() - this.startGuard.startedAt < 120_000
      && (this.startGuard.inFlight || activePhases.has(this.state.phase))) {
      getTraceRecorder()?.emit({
        kind: 'phase.changed',
        sessionId: this.context.sessionId || null,
        payload: { note: 'session.start.duplicate_ignored', repoPath: effectiveGuardPath },
      });
      this.emit({ type: 'session:state_changed', payload: { state: this.state, context: this.context } });
      return;
    }
    this.startGuard = { repoPath: effectiveGuardPath, startedAt: Date.now(), inFlight: true };
    try {
      await this.startSessionInner(repoPath, sinceDays);
    } finally {
      if (this.startGuard) this.startGuard.inFlight = false;
    }
  }

  private async startSessionInner(repoPath: string, sinceDays?: number) {
    try {
      const effectivePath = repoPath || this.config.repoPath;
      this.activeRepoPath = effectivePath;
      // Grounding retriever lives for the whole session and reads the live
      // working tree + cache DB at retrieve() time — construct it FIRST.
      // It used to be built inside the cache-warming block below, which
      // zero-commit (quiet-week) sessions return before reaching, leaving
      // every answer ungrounded exactly when the repo is docs-only.
      const { Retriever } = await import('../intelligence/retriever.js');
      this.retriever = new Retriever(this.db.getContextCacheRepo(), effectivePath);
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

      // Session-open narration: ONE stream from the welcome through the
      // proposal, emitted as soon as each piece is known. The welcome is
      // chunk 0 — spoken within ~300ms of Begin.
      this.openStreamId = null;
      this.openStreamSeq = 0;
      // Fresh session — no held floor state may carry over.
      this.currentTurnStreamId = null;
      this.currentTurnBriefingId = null;
      this.pendingFloorNarration = [];
      if (this.floorReleaseTimer) {
        clearTimeout(this.floorReleaseTimer);
        this.floorReleaseTimer = null;
      }
      const isFirstVisit = !previousSessionRecord;
      // Statement-only welcome: the session open ends with the narrated
      // proposal, which asks THE one question. The old triple-prompt
      // ("Where do you want to start?" + "Where do you want to pick up?"
      // + "What would you like to explore?") fired three questions in
      // 300ms — pure noise (live session 2026-06-09).
      const greetingText = isFirstVisit
        ? `Let me take a look at ${repoName} for the first time.`
        : `Welcome back to ${repoName}.`;
      await this.emitOpenChunks(greetingText, false);

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

      // Per-session visual state: stale aliases from the previous repo
      // must never anchor this session's narration.
      this.anchorIndex = null;
      this.clientScope = 'project';
      // Instant opener: deliver the cached project briefing NOW (before
      // the long ANALYZING block) — navigator push, comprehension
      // observation, and the narration:briefing card all still happen —
      // but speak only the first 1-2 sentences, NOT the 30s pitch that
      // used to play identically every session and bury the proposal.
      // (Duplicate-start protection lives in the startSession guard.)
      this.navigator.reset();
      const cachedProjectBriefing = this.db.getBriefingRepo().get(effectivePath, 'project');
      if (cachedProjectBriefing) {
        // The briefing's spoken sentences ride the OPEN STREAM, ordered
        // after the welcome (speakViaOpenStream → narration:briefing goes
        // out spoken:false). Letting the frontend speak it via the
        // greeting lane raced the opener and cut "Welcome back…" off
        // mid-word, orphaning the rest of the open narration.
        const spokenOpener = this.deliverBriefing(
          cachedProjectBriefing,
          'session_start',
          undefined,
          firstSentences(cachedProjectBriefing.opener, 2) || undefined,
          true,
        );
        if (spokenOpener.trim()) {
          await this.emitOpenChunks(spokenOpener, false);
        }
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

      // Updates recap — the REAL "what's changed" line the greeting used
      // to promise and never deliver. Deterministic, no LLM: commit count
      // anchored to the previous session's date, plus the hottest folder.
      if (this.entryMode === 'updates' && commits.length > 0) {
        try {
          const sinceLabel = humanDate(previousSessionRecord?.startedAt ?? since.toISOString());
          const folderCounts = new Map<string, number>();
          for (const cd of commits) {
            for (const fc of (cd.commit.filesChanged ?? [])) {
              const top = fc.path.split('/')[0] || '.';
              folderCounts.set(top, (folderCounts.get(top) ?? 0) + 1);
            }
          }
          const hot = [...folderCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
          const recap = `${commits.length} commit${commits.length === 1 ? '' : 's'} since ${sinceLabel}`
            + (hot ? ` — most of the activity is in ${hot}.` : '.');
          await this.emitOpenChunks(recap, false);
        } catch { /* recap is best-effort */ }
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

          await this.emitOpenChunks(greetingText, false);

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
              narrated: true,
            },
          });
          this.setState({ phase: 'PROPOSAL' });
          // Narrated through the SAME open stream — the proposal is the
          // defining interaction and must actually be heard. No timer:
          // the session waits indefinitely (vision: "it waits").
          await this.emitOpenChunks(proposalMessage, true);
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
          this.emitComprehensionUpdate(effectivePath, staledId, 'stale', 'confirmed');
        }

        // Pre-warm diagram payloads (project + per-module, both views)
        // so click-to-drill on the radial map is instant. Cassette-backed
        // for the LLM portion. Skipped on warm starts when source hash
        // hasn't drifted.
        try {
          const { warmDiagrams } = await import('../intelligence/diagram-warmer.js');
          // Structured-call surface for the flow-precompile pass — reuses the
          // session's Claude client (it has structuredCall) so warm-time flow
          // authoring needs no separate analyzer wiring.
          const flowAnalyzer = aiClient
            ? {
                structuredCallDirect: <T>(p: { prompt: string; toolName: string; toolDescription: string; inputSchema: unknown }) =>
                  aiClient!.structuredCall<T>({
                    system: 'You author small, accurate architecture/flow diagrams grounded ONLY in the files and import edges you are given.',
                    messages: [{ role: 'user', content: p.prompt }],
                    toolName: p.toolName,
                    toolDescription: p.toolDescription,
                    inputSchema: p.inputSchema as Record<string, unknown>,
                  }),
              }
            : undefined;
          await warmDiagrams(
            effectivePath,
            this.db.getContextCacheRepo(),
            this.db.getDiagramCacheRepo(),
            this.db.getComprehensionRepo(),
            aiClient ? getDefaultLLMAdapter() : null,
            (msg) => this.emit({ type: 'analysis:progress', payload: { phase: 'warming_cache', progress: 0.55, message: msg } }),
            flowAnalyzer,
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
          retriever: this.retriever ?? undefined,
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
          narrated: true,
        },
      });
      this.setState({ phase: 'PROPOSAL' });
      // Spoken through the open stream (card first so the UI is already in
      // PROPOSAL when audio starts). isFinal closes the session-open
      // stream; from here the user steers — indefinitely, no auto-accept.
      await this.emitOpenChunks(proposalMessage, true);
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
  private async emitNarrationChunked(
    text: string,
    opts?: {
      /** Join an existing turn stream (the spoken ack is its seq 0). When
       *  set, the greeting fallback is disabled — the stream MUST get an
       *  isFinal chunk or the frontend transcript never assembles. */
      streamId?: string;
      startSeq?: number;
      /** Hard sentence cap. Over-cap text is dropped at a sentence
       *  boundary and the steering hook is appended (unless disabled). */
      capSentences?: number;
      appendHookOnTruncate?: boolean;
    },
  ): Promise<{ truncated: boolean; spokenText: string }> {
    let trimmed = text.trim();
    if (!trimmed) return { truncated: false, spokenText: '' };
    const { chunkAnswerWithAnchors, splitIntoSentences } = await import('../intelligence/sentence-chunker.js');
    const { STEERING_HOOK, artifactReplacementLine } = await import('./answer-streamer.js');
    const nodeLabels = await this.knownNodeLabels();

    // Fenced code is lifted to the screen (visual:artifact), never spoken.
    // Runs BEFORE sentence splitting — the boundary regex shreds code.
    const extraction = extractFencedArtifacts(trimmed);
    if (extraction.artifacts.length > 0) {
      const baseId = opts?.streamId ?? `nar-${Date.now()}`;
      extraction.artifacts.forEach((a, i) => this.emitArtifact(`${baseId}-a${i}`, a));
      trimmed = extraction.clean;
      if (!/on (the |your )?screen/i.test(trimmed)) {
        trimmed = trimmed
          ? `${trimmed} ${artifactReplacementLine(extraction.artifacts)}`
          : artifactReplacementLine(extraction.artifacts);
      }
    }

    // Post-hoc cap for complete-string narrations (skills): truncate at a
    // sentence boundary, same semantics as the live answer streamer.
    let speakText = trimmed;
    let truncated = false;
    if (opts?.capSentences && opts.capSentences > 0) {
      const sentences = splitIntoSentences(trimmed);
      if (sentences.length > opts.capSentences) {
        speakText = sentences.slice(0, opts.capSentences).join(' ');
        truncated = true;
      }
    }

    const tagged = chunkAnswerWithAnchors(speakText, nodeLabels);
    if (truncated && (opts?.appendHookOnTruncate ?? true)) {
      tagged.push({ text: STEERING_HOOK, referencedNodes: [] });
    }
    if (tagged.length <= 1 && !opts?.streamId) {
      // Trivial: one chunk → fall back to greeting (preserves legacy
      // tests/UI flows that listen for narration:greeting on short
      // replies). The user-facing concern (robotic 250-word blobs) is
      // about LONG narrations; one-chunk is fine as a greeting.
      this.emit({ type: 'narration:greeting', payload: { text: speakText } });
      return { truncated, spokenText: speakText };
    }
    const streamId = opts?.streamId ?? `nar-${Date.now()}`;
    const startSeq = opts?.startSeq ?? 0;
    for (let i = 0; i < tagged.length; i++) {
      this.emit({
        type: 'narration:stream_chunk',
        payload: {
          streamId,
          seq: startSeq + i,
          text: tagged[i].text,
          isFinal: i === tagged.length - 1,
          referencedNodes: tagged[i].referencedNodes,
        },
      });
    }
    return { truncated, spokenText: speakText };
  }

  /** Ship a fenced-code artifact to the screen as a copyable card. Uses
   *  rawEmit: artifacts are VISUAL, not speech — the floor gate must not
   *  drop or delay them (the card appearing while the user talks is fine;
   *  audio talking over them is not). */
  private emitArtifact(id: string, artifact: ExtractedArtifact): void {
    this.rawEmit({
      type: 'visual:artifact',
      payload: {
        id,
        kind: classifyArtifact(artifact),
        language: artifact.language || undefined,
        body: artifact.code,
      },
    });
  }

  /** Lazily build (and cache) the alias→node anchor index. Invalidated
   *  at session start. Built from the diagram cache + context cache, so
   *  it works whenever those are warm — no ordering dependency on the
   *  analysis pipeline. */
  private async getAnchorIndex(): Promise<import('../intelligence/anchor-index.js').AnchorIndex | null> {
    if (this.anchorIndex && this.anchorIndex.entries.length > 0) return this.anchorIndex;
    const repoPath = this.activeRepoPath || this.config.repoPath;
    if (!repoPath) return null;
    try {
      const { buildAnchorIndex } = await import('../intelligence/anchor-index.js');
      const built = buildAnchorIndex({
        diagramRows: this.db.getDiagramCacheRepo().listForRepo(repoPath),
        modules: this.db.getContextCacheRepo().getModulesForRepo(repoPath),
        fileTree: this.fileTree,
        areas: this.areas,
      });
      // Only cache a NON-empty index. The session-open narration runs
      // before the caches are warm — caching the empty result there
      // would blind anchors + visual dispatch for the whole session.
      if (built.entries.length > 0) this.anchorIndex = built;
      return built;
    } catch {
      return null;
    }
  }

  /** Pulls anchor-able tokens so the chunker can anchor-tag narration.
   *  Backed by the anchor index (diagram labels + leaf/file/case-variant
   *  aliases); falls back to bare module names when nothing is warm. */
  private async knownNodeLabels(): Promise<string[]> {
    const repoPath = this.activeRepoPath || this.config.repoPath;
    if (!repoPath) return [];
    const index = await this.getAnchorIndex();
    if (index && index.entries.length > 0) {
      return index.allAliases();
    }
    try {
      const labels = new Set<string>();
      const modules = this.db.getContextCacheRepo().getModulesForRepo(repoPath);
      for (const m of modules) labels.add(m.modulePath);
      for (const m of modules) {
        const base = m.modulePath.split('/').pop();
        if (base) labels.add(base);
      }
      return [...labels].filter(l => l.length >= 3); // skip 1-2 char noise
    } catch { return []; }
  }

  /** THE single visual sink: every answered turn drives the diagram.
   *  Resolves refs (REFS line + lexical anchors) against the anchor
   *  index, classifies the move via dispatchVisual, and emits a
   *  visual:dispatch event — ALWAYS, even with zero refs (IN_PLACE /
   *  'no-refs'), so the diagram is never static after an answer. */
  private async dispatchAnswerVisual(opts: {
    /** Skill target / focus node / first REF — the primary subject. */
    primaryTarget?: string;
    /** Free-form names the answer discussed (REFS items, anchor hits). */
    refs?: string[];
    /** The user's question for this turn — lets answered turns feed the
     *  comprehension model (nodes the answer discussed advance to 'heard';
     *  a node the user NAMED in the question advances to 'explained'). */
    question?: string;
  }): Promise<void> {
    try {
      const index = await this.getAnchorIndex();
      const refIds: string[] = [];
      for (const name of opts.refs ?? []) {
        const id = index?.resolveName(name) ?? null;
        if (id && !refIds.includes(id)) refIds.push(id);
      }

      // Every answered turn climbs the knowledge ladder. Before this,
      // streamed Q&A fed comprehension NOTHING — a whole conversation
      // about a module left the knowledge strip frozen ("Seen 0%",
      // count stuck at 1) and the ladder looked dead.
      this.creditAnswerComprehension(refIds, index?.labels() ?? {}, opts.question);

      const target = opts.primaryTarget ?? opts.refs?.[0] ?? '';
      const repoPath = this.activeRepoPath || this.config.repoPath;
      const scopeRow = repoPath
        ? this.db.getDiagramCacheRepo().listForRepo(repoPath).filter(r => r.scope === this.clientScope)
        : [];
      const knownNodeIds = [...new Set(scopeRow.flatMap(r => r.nodes.map(n => n.id)))];
      const nodeLabels = Object.fromEntries(scopeRow.flatMap(r => r.nodes.map(n => [n.id, n.label] as const)));

      const { dispatchVisual } = await import('../intelligence/visual-dispatcher.js');
      const result = target
        ? dispatchVisual({
            target,
            currentScope: this.clientScope === 'project' ? null : this.clientScope,
            knownNodeIds,
            nodeLabels,
            navigatorAncestors: this.clientScope.startsWith('module/') ? ['project'] : [],
            globalNodeIds: index?.allNodeIds() ?? [],
            globalNodeLabels: index?.labels(),
          })
        : null;

      // GENERATE downgrades to IN_PLACE — only the visualize skill
      // authors new diagrams; everything else acknowledges in place.
      const transition = !result || result.transition === 'GENERATE' ? 'IN_PLACE' : result.transition;
      const targetNodeId = result?.targetNodeId
        ?? (this.clientScope === 'project' ? undefined : this.clientScope);
      this.emit({
        type: 'visual:dispatch',
        payload: {
          transition,
          targetNodeId,
          refs: refIds,
          reason: result?.reason ?? 'no-refs',
          suggestion: result?.suggestion,
        },
      });
    } catch { /* visuals are best-effort — never block the spoken answer */ }
  }

  /** Answered-turn comprehension credit: each node the answer discussed
   *  observes 'heard' (cooldown applies — chatty turns can't spam);
   *  a node the user named in their own question observes 'explained'
   *  (asking about a thing by name is active engagement — same semantics
   *  as the existing question_asked sites). */
  private creditAnswerComprehension(
    refIds: string[],
    labels: Record<string, string>,
    question?: string,
  ): void {
    if (refIds.length === 0) return;
    const q = (question ?? '').toLowerCase();
    for (const id of refIds) {
      // Canonical-identity guard: only project/module/file/arch/concept ids
      // are real comprehension items. A bare kebab id (an authored flow node
      // that didn't ground to a file) must NOT create a throwaway row — that's
      // what fragmented the count (data-cleaner AND file/core/data_cleaner.py).
      if (!isCanonicalItemId(id)) continue;
      const label = labels[id] ?? id.split('/').pop() ?? id;
      const namedInQuestion =
        q.length > 0 &&
        (q.includes(label.toLowerCase()) || q.includes((id.split('/').pop() ?? '').toLowerCase()));
      if (namedInQuestion) {
        this.observeComprehension(id, label, 'explained', 'question_asked', { questionsAsked: 1 });
      } else {
        this.observeComprehension(id, label, 'heard', 'qa_answer');
      }
    }
  }

  private async handleQuestion(
    question: string,
    classifierParams: Record<string, string> = {},
    opts?: {
      /** Join the turn stream handleUtterance opened with its spoken ack. */
      streamId?: string;
      startSeq?: number;
    },
  ) {
    // Voice-first: answer inline via narration, don't transition to QA modal.
    // The answer is spoken aloud and shown in the narration bar.

    // Defense-in-depth: if the transcript is empty / a Whisper hallucination,
    // stay silent. The frontend filter catches most of these — this guards
    // anything that slipped through (other input paths, integration tests,
    // direct WS clients). No reply, no LLM call, no qaTurns mutation.
    if (isLikelyTranscriptionNoise(question)) return;

    const repoPath = this.activeRepoPath || this.config.repoPath;

    const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
    const currentLocation = currentArea
      ? `Phase: ${this.state.phase}. Area: ${currentArea.name}. ${currentArea.description}`
      : `Phase: ${this.state.phase}.`;

    // Build the cached scaffold once — same input both paths. Recent turns
    // include both this session's qaTurns AND prior-session highlights so
    // follow-ups like "what about it?" carry over across days.
    const { buildQAContext } = await import('../intelligence/qa-context.js');
    const { detectDepth, sentenceCap } = await import('../intelligence/depth-modifiers.js');
    // Update the session's depth tier from the current question. When the
    // call came through handleUtterance this is idempotent (the tier was
    // already updated there); direct callers (session:question event) get
    // the same behavior.
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
            ? 'Sure — going deeper now.'
            : '')
      : '';

    // Turn stream: every spoken piece of this turn (ack → answer sentences
    // → steering hook) shares one streamId so the frontend assembles a
    // single transcript entry and never resets the queue mid-answer.
    const streamId = opts?.streamId ?? `qa-${Date.now()}`;
    this.currentTurnStreamId = streamId;
    let seq = opts?.startSeq ?? 0;
    if (!opts?.streamId && depthAck) {
      // Direct-call path (no handleUtterance ack): speak the depth ack as
      // the stream's opening chunk.
      this.emit({
        type: 'narration:stream_chunk',
        payload: { streamId, seq: seq++, text: depthAck, isFinal: false, referencedNodes: [] },
      });
    }

    const persistAnswer = (answer: string) => {
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
    };

    // Grounding: deterministic retrieval injects REAL file contents into
    // the prompt in ALL modes — the agentic CLI tools are escalation-only
    // now, so the normal path stays fast and streamable.
    let retrieval: import('../intelligence/retriever.js').RetrievalResult | null = null;
    try {
      retrieval = this.retriever?.retrieve({ question, params: classifierParams }) ?? null;
    } catch { retrieval = null; }
    const groundedSystem = (agenticTools: boolean) =>
      baseSystem(agenticTools) + (retrieval ? `\n\n${retrieval.promptBlock}` : '');
    getTraceRecorder()?.emit({
      kind: 'qa.route',
      sessionId: this.context.sessionId || null,
      payload: { route: 'retrieval', confidence: retrieval?.confidence ?? 'none', files: retrieval?.files.length ?? 0 },
    });

    // Consume a live token stream: sentences speak as they complete (the
    // first one ~1-2s after the LLM starts), the sentence cap aborts the
    // stream and appends the steering hook. Returns false when the stream
    // produced nothing (lets the caller try the next client / apology).
    const { streamAnswerToChunks } = await import('./answer-streamer.js');
    const nodeLabels = await this.knownNodeLabels();
    const runStream = async (handle: LLMStreamHandle): Promise<boolean> => {
      const anchorHits = new Set<string>();
      let artifactCount = 0;
      const result = await streamAnswerToChunks(handle, {
        streamId,
        startSeq: seq,
        nodeLabels,
        maxSentences: sentenceCap(this.depthTier),
        emitChunk: c => {
          for (const r of c.referencedNodes) anchorHits.add(r);
          this.emit({
            type: 'narration:stream_chunk',
            payload: { streamId, seq: c.seq, text: c.text, isFinal: c.isFinal, referencedNodes: c.referencedNodes },
          });
        },
        // Fenced code goes to the screen as a copyable card the moment
        // the fence closes — never into the spoken audio.
        onArtifact: a => this.emitArtifact(`${streamId}-a${artifactCount++}`, a),
      });
      // An answer that was ONLY an artifact still counts as answered.
      if (!result.fullText.trim() && result.artifacts.length === 0) return false;
      persistAnswer(
        result.artifacts.length > 0
          ? `${result.fullText}\n${result.artifacts.map(a => `\`\`\`${a.language}\n${a.code}\n\`\`\``).join('\n')}`.trim()
          : result.fullText,
      );
      this.lastTruncated = result.truncated
        ? { question, params: classifierParams, at: Date.now() }
        : null;
      // Visual pairing: the model's REFS line (held back by the splitter)
      // plus lexical anchor hits drive the diagram for this answer.
      const { parseRefsLine } = await import('../intelligence/answer-refs.js');
      void this.dispatchAnswerVisual({
        refs: [...parseRefsLine(result.refsLine), ...anchorHits],
        question,
      });
      return true;
    };

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
          // Normal route is retrieval-grounded even on the CLI (fast,
          // streamable, mode-symmetric). Agentic tools are escalation-only.
          const client = new ClaudeCodeClient('sonnet', repoPath);
          const handle = client.streamTextLive({
            system: groundedSystem(false),
            messages: [{ role: 'user' as const, content: userMessage }],
          });
          if (await runStream(handle)) {
            await this.maybeOfferEscalation(question, retrieval);
            return;
          }
        }
      }
      if ((mode === 'cloud' || mode === 'auto') && this.config.anthropicApiKey) {
        const { ClaudeClient } = await import('../intelligence/claude-client.js');
        const client = new ClaudeClient(this.config.anthropicApiKey);
        const handle = client.streamTextLive({
          system: groundedSystem(false),
          messages: [{ role: 'user' as const, content: userMessage }],
        });
        if (await runStream(handle)) {
          await this.maybeOfferEscalation(question, retrieval);
          return;
        }
      }
    } catch (err: any) {
      console.error('Q&A fallback error:', err.message);
    }

    // Apology goes through the SAME stream so an already-spoken ack still
    // gets its isFinal chunk and the transcript assembles.
    await this.emitNarrationChunked(
      "Sorry, I couldn't process that. Make sure the Claude CLI is installed or an API key is set.",
      { streamId, startSeq: seq },
    );
  }

  /** After an anchors-only answer (retrieval found nothing beyond
   *  README/manifest), offer the deep scan and arm the affirmative. */
  private async maybeOfferEscalation(
    question: string,
    retrieval: { confidence: string } | null,
  ): Promise<void> {
    if (retrieval?.confidence !== 'anchors-only') return;
    // Only offer the deep scan when the question asked about something
    // SPECIFIC that retrieval failed to find. Generic questions ("what is
    // this?") legitimately have no file match — offering a code dig after
    // every one of those is nagging, not helpfulness.
    const { extractKeywords } = await import('../cache/context-composer.js');
    if (extractKeywords(question).length < 2) return;
    const { ESCALATION_OFFER, PENDING_ESCALATION_TTL_MS } = await import('./qa-router.js');
    this.pendingEscalation = { question, expiresAt: Date.now() + PENDING_ESCALATION_TTL_MS };
    // Greeting lane: the orchestrator's serialized speech queue plays it
    // after the answer stream finishes.
    this.emit({ type: 'narration:greeting', payload: { text: ESCALATION_OFFER } });
  }

  /** The slow-but-thorough path: Claude Code CLI reads the repo itself.
   *  Reached only by explicit escalation — a spoken buffer covers the
   *  10-30s the agentic pass takes. */
  private async runAgenticAnswer(question: string): Promise<void> {
    const repoPath = this.activeRepoPath || this.config.repoPath;
    const streamId = `qa-${Date.now()}`;
    this.currentTurnStreamId = streamId;
    const { AGENTIC_BUFFER_LINE } = await import('./qa-router.js');
    this.emit({
      type: 'narration:stream_chunk',
      payload: { streamId, seq: 0, text: AGENTIC_BUFFER_LINE, isFinal: false, referencedNodes: [] },
    });
    getTraceRecorder()?.emit({
      kind: 'qa.route',
      sessionId: this.context.sessionId || null,
      payload: { route: 'agentic', question },
    });

    const { buildQAContext } = await import('../intelligence/qa-context.js');
    const { sentenceCap } = await import('../intelligence/depth-modifiers.js');
    const system = buildQAContext(this.db.getContextCacheRepo(), repoPath, {
      agenticTools: true,
      recentTurns: this.qaTurns,
      depthTier: 'deep',
    });

    try {
      const { ClaudeCodeClient } = await import('../intelligence/claude-code-client.js');
      // Cloud-forced sessions (tests, no-CLI deployments) never spawn the
      // CLI even when one happens to be installed on the machine.
      if (this.config.intelligenceMode !== 'cloud' && await ClaudeCodeClient.isAvailable()) {
        const client = new ClaudeCodeClient('sonnet', repoPath);
        const answer = await client.streamText({
          system,
          messages: [{ role: 'user' as const, content: question }],
        });
        if (answer.trim()) {
          this.qaTurns.push({ role: 'user', content: question });
          this.qaTurns.push({ role: 'assistant', content: answer });
          if (this.qaTurns.length > this.QA_HISTORY_MAX) {
            this.qaTurns = this.qaTurns.slice(-this.QA_HISTORY_MAX);
          }
          try {
            const qaHistory = this.db.getQAHistoryRepo();
            qaHistory.record({ repoPath, sessionId: this.context.sessionId, role: 'user', content: question });
            qaHistory.record({ repoPath, sessionId: this.context.sessionId, role: 'assistant', content: answer });
          } catch (err: any) {
            console.warn('Failed to persist QA turn:', err.message);
          }
          // Deep work earns the deep cap.
          await this.emitNarrationChunked(answer, {
            streamId, startSeq: 1, capSentences: sentenceCap('deep'),
          });
          return;
        }
      }
    } catch (err: any) {
      console.error('Agentic answer error:', err.message);
    }

    // CLI unavailable (cloud-only / CI): spoken caveat, then the best
    // retrieval-grounded answer we can give — never silence.
    this.emit({
      type: 'narration:stream_chunk',
      payload: { streamId, seq: 1, text: "I can't run a deep scan right now, but here's what I can see.", isFinal: false, referencedNodes: [] },
    });
    await this.handleQuestion(question, {}, { streamId, startSeq: 2 });
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

    // Done — finalize. v2: a quiz no longer inflates `level` (level is
    // taught/presentation only). It writes the active-recall RATIO; the
    // displayed knowledge is derived from that.
    const correctCount = this.activeQuiz.answers.filter(a => a.correct).length;
    const total = this.activeQuiz.questions.length;
    const repoPath = this.activeRepoPath;
    const repo = this.db.getComprehensionRepo();
    const previousLevel = repo.get(repoPath, this.activeQuiz.briefingId)?.level ?? 'unknown';

    if (repoPath) {
      // Taking a quiz is active engagement → ensure the row + an
      // ≥explained level (taught is already satisfied; this just
      // guarantees the row exists for the writes below).
      this.observeComprehension(this.activeQuiz.briefingId, this.activeQuiz.label, 'explained', 'question_asked');
      repo.recordQuiz(repoPath, this.activeQuiz.briefingId, correctCount, total);
      // Each missed question → an actionable study item.
      const correctIds = new Set(this.activeQuiz.answers.filter(a => a.correct).map(a => a.questionId));
      for (const q of this.activeQuiz.questions) {
        if (!correctIds.has(q.id)) repo.addWeakSpot(repoPath, this.activeQuiz.briefingId, q.question, 'quiz');
      }
      // A PERFECT quiz (3/3) is an active-recall QA proof, equivalent
      // to passing a grill — flip the standalone `grilled` marker.
      if (correctCount === total) repo.markGrilled(repoPath, this.activeQuiz.briefingId);
      this.emitComprehensionUpdate(repoPath, this.activeQuiz.briefingId, 'quiz');
    }

    this.emit({
      type: 'quiz:result',
      payload: {
        briefingId: this.activeQuiz.briefingId,
        correct: correctCount,
        total,
        previousLevel,
        newLevel: repo.get(repoPath, this.activeQuiz.briefingId)?.level ?? previousLevel,
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
      // Strong answers under questioning are active recall — bump the
      // topic toward 'explained' (the grilled flag + persisted ratio is
      // set on completion in the result.done branch).
      const lastEvals = this.activeGrill.turns.slice(-3).map(t => t.evaluation);
      const strongStreak = lastEvals.filter(e => e === 'strong').length;
      if (strongStreak >= 2) {
        this.observeComprehension(
          `topic/${this.activeGrill.topic.replace(/\s+/g, '-').toLowerCase()}`,
          this.activeGrill.topic,
          'explained',
          'question_asked',
          {},
        );
      }
      if (result.done) {
        const repoPath = this.activeRepoPath;
        if (repoPath) {
          const repo = this.db.getComprehensionRepo();
          const topic = this.activeGrill.topic;
          const topicId = `topic/${topic.replace(/\s+/g, '-').toLowerCase()}`;
          const answered = this.activeGrill.turns.filter(t => !!t.evaluation);
          const strong = answered.filter(t => t.evaluation === 'strong').length;
          // Completing a grill is active engagement → at least 'explained'
          // (guarantees the row exists for the writes below).
          this.observeComprehension(topicId, topic, 'explained', 'question_asked');
          // Always persist the ratio (v2 — the score must survive reload).
          repo.recordGrill(repoPath, topicId, strong, answered.length);
          // Each weak/partial question becomes an actionable study item.
          for (const t of answered) {
            if (t.evaluation === 'weak' || t.evaluation === 'partial') {
              repo.addWeakSpot(repoPath, topicId, t.question, 'grill');
            }
          }
          // PASS bar (≥3 Qs, ≥60% strong) flips the standalone QA proof.
          if (answered.length >= 3 && strong >= Math.ceil(answered.length * 0.6)) {
            repo.markGrilled(repoPath, topicId);
          }
          this.emitComprehensionUpdate(repoPath, topicId, 'grill');
        }
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
    // v3 Seen-coverage: a briefing's narration ACTUALLY finished
    // playing (real dwell — not "we emitted it"). The most-recently
    // delivered briefing is what just played to completion; credit it
    // as seen. This is the sole input to the Seen metric.
    const repoPath = this.activeRepoPath;
    if (repoPath) {
      // Credit the briefing the client actually finished playing. The client
      // sends its id explicitly now — prefer it over lastBriefingId, which is
      // wrong if the user navigated to another briefing mid-playback. Tour
      // segments (ids like "s1") aren't briefings → fall back to lastBriefingId.
      const seenId =
        segmentId && this.db.getBriefingRepo().get(repoPath, segmentId)
          ? segmentId
          : this.lastBriefingId;
      if (seenId) {
        this.db.getComprehensionRepo().markSeen(repoPath, seenId);
        this.emitComprehensionUpdate(repoPath, seenId, 'seen');
        // If this briefing surfaced a flow, its narration (P1) described every
        // stage — so the stages are seen too. Credits the canonical file items
        // the flow stages share, so the flow view shows real Seen% (not 0%).
        if (this.lastSurfacedFlow?.briefingId === seenId) {
          for (const stage of this.lastSurfacedFlow.stages) {
            this.db.getComprehensionRepo().markSeen(repoPath, stage.itemId);
            this.emitComprehensionUpdate(repoPath, stage.itemId, 'seen');
          }
          // Consumed — clear so a later unrelated segment can't re-credit it.
          this.lastSurfacedFlow = null;
        }
      }
    }
    // Close the whats_changed loop: being walked through a changed
    // area = you've caught up on it. Mark its files reviewed and
    // re-emit the heatmap so the node cools to green live as you go.
    if (this.state.phase === 'AREA_WALKTHROUGH' || this.state.phase === 'COMPONENT_TOUR') {
      void this.coolWalkedArea();
    }
    // Auto-advance to next segment when narration finishes
    if ((this.state.phase === 'AREA_WALKTHROUGH' || this.state.phase === 'COMPONENT_TOUR') && !this.state.paused) {
      this.navigateNext();
    }
  }

  /** The user was just walked through the current area's changes →
   *  stamp its files reviewed (decision: walked-through = caught up,
   *  no quiz gate) and recompute+re-emit the heatmap so the field
   *  cools to green in real time. Best-effort; never blocks the tour. */
  private async coolWalkedArea(): Promise<void> {
    const repoPath = this.activeRepoPath;
    const area = this.areas[this.state.areaIndex ?? -1];
    if (!repoPath || !area?.affectedFiles?.length) return;
    try {
      const heatRepo = this.db.getHeatmapRepo();
      for (const f of area.affectedFiles) {
        heatRepo.markReviewed(repoPath, f, this.context.sessionId, '');
      }
      this.heatmapData = await computeHeatmap(
        repoPath,
        simpleGit(repoPath),
        heatRepo.getForRepo(repoPath),
      );
      this.emit({ type: 'session:heatmap', payload: { heatmap: this.heatmapData } });
    } catch {
      /* heatmap cooling is best-effort — a git/io hiccup must not
         break the walkthrough */
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

  /** Emit a briefing AND push it on the navigator stack (if not already top).
   *  Returns the spoken opener it resolved (post-abbreviation) so a caller
   *  using `speakViaOpenStream` can route that text onto the open stream. */
  private deliverBriefing(
    briefing: import('@tetherline/shared').Briefing,
    reason: 'user_asked' | 'dive_deeper' | 'tour_next' | 'resume_pop' | 'session_start',
    resumePrefix?: string,
    /** Shorter spoken text to use instead of the full opener (e.g. the
     *  2-sentence session-start greeting). Re-entry abbreviations still
     *  take priority — they're shorter yet. */
    openerOverride?: string,
    /** When true, narration:briefing goes out with spoken:false (visual /
     *  navigator / comprehension effects only) and the CALLER speaks the
     *  returned text on the session-open stream. Without this the briefing
     *  rode the frontend's greeting lane, which ABORTS in-flight audio —
     *  at session start it cut "Welcome back…" off mid-word and orphaned
     *  the rest of the opener (live 2026-06-12). */
    speakViaOpenStream = false,
  ): string {
    const top = this.navigator.peek();
    if (top?.briefingId !== briefing.id) {
      const check = this.navigator.checkPush(briefing.id);
      if (check.allowed) {
        // eslint-disable-next-line no-console
        console.log(`[trace] briefing.push id=${briefing.id} layer=${briefing.layer} reason=${reason} phase=${this.state.phase}`);
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
    let openerToEmit = openerOverride ?? briefing.opener;
    if (reason === 'session_start' && minutesSinceLast !== null) {
      // Session-start openers are STATEMENTS, never questions: the open
      // stream always ends with the narrated proposal, which asks the
      // session's one question. Stacking "pick up?"/"continue?" before
      // it produced three questions in a row.
      if (minutesSinceLast < 30) {
        // Quick re-entry — skip the briefing, just acknowledge. (No
        // "Welcome back" here — the session-open stream already welcomed.)
        openerToEmit = `Picking up where we left off.`;
      } else if (minutesSinceLast < 24 * 60) {
        // Same-day re-entry — keep just the first sentence.
        openerToEmit = briefing.opener.split(/(?<=[.!?])\s+/)[0] ?? briefing.opener;
      }
      // ≥24 h → the override (short opener) or full opener.
    }

    // Cross-lane coherence: when this module briefing will surface a
    // precompiled flow, SPEAK that flow's narration (validated to name only its
    // own stages) instead of the file-listing opener — otherwise the user hears
    // more components than the diagram shows (live "I see five but you named a
    // lot more", 2026-06-10). Computed once; the row is reused by the surface.
    let surfacedFlow: DiagramRow | null = null;
    if ((reason === 'user_asked' || reason === 'dive_deeper') && briefing.layer === 'module' && repoPath) {
      const coherent = this.coherentFlowOpener(repoPath, briefing);
      if (coherent) {
        openerToEmit = coherent.text;
        surfacedFlow = coherent.row;
      }
    }

    // This briefing is a DIRECT response to the user's utterance — hold it
    // through the post-silence window instead of dropping it. Proactive
    // briefings (session_start / tour_next / resume_pop) stay droppable.
    if (reason === 'user_asked' || reason === 'dive_deeper') {
      this.currentTurnBriefingId = briefing.id;
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
        spoken: !speakViaOpenStream,
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

    // Jump-to-flow: when the user ASKS about a module ("tell me about core"),
    // surface its pre-authored workflow right after the spoken briefing —
    // they shouldn't have to ask twice to see the flow (live note 2026-06-10).
    // The row was already resolved above (coherentFlowOpener) so we don't
    // re-read it; surfacing only fires when that found a flow.
    if (surfacedFlow && repoPath) {
      // The spoken briefing (P1) names every stage, so each grounded stage is
      // now 'heard' under its CANONICAL file item — observe them (creating the
      // items if needed) and remember them so segment_finished marks them seen.
      const stages = surfacedFlow.nodes
        .filter(n => typeof n.briefingId === 'string')
        .map(n => ({ itemId: n.briefingId as string, label: n.label }));
      for (const s of stages) {
        this.observeComprehension(s.itemId, s.label, 'heard', 'qa_answer');
      }
      this.lastSurfacedFlow = { briefingId: briefing.id, stages };
      this.maybeSurfaceFlow(repoPath, surfacedFlow);
    }

    return openerToEmit;
  }

  /** A coherent spoken opener for a module that has a precompiled flow: a short
   *  lead from the briefing (dropped if it names a stage not in the flow) + the
   *  flow's own validated narration + a bridge line when the module holds more
   *  files than the flow shows. Returns null when there's no usable flow. */
  private coherentFlowOpener(repoPath: string, briefing: import('@tetherline/shared').Briefing): { text: string; row: DiagramRow } | null {
    const row = this.db.getDiagramCacheRepo().get(repoPath, `flow/${briefing.id}`, 'logic');
    if (!row || !row.nodes || row.nodes.length < 3 || !row.narration?.trim()) return null;
    const labels = row.nodes.map(n => n.label);
    let lead = firstSentences(briefing.opener, 2);
    // Drop the lead if it names a component the flow doesn't show.
    if (lead && !narrationMentionsOnly(lead, labels)) lead = '';
    const modulePath = briefing.id.replace(/^module\//, '');
    const keyFiles = this.db.getContextCacheRepo().getModule(repoPath, modulePath)?.keyFiles ?? [];
    const bridge = keyFiles.length > row.nodes.length ? FLOW_BRIDGE_LINE : '';
    const text = [lead, row.narration.trim(), bridge].filter(Boolean).join(' ');
    return { text, row };
  }

  /** Emit a visualize-shaped skill:result for a precompiled module flow, so
   *  the frontend's existing authored-swap + auto-logic-view path shows it.
   *  Overlays LIVE comprehension onto the stages (by their canonical file
   *  briefingId) so the surfaced flow shows real Seen%/levels — authored
   *  flows bypass the diagram route, so we apply the overlay here. */
  private maybeSurfaceFlow(repoPath: string, row: DiagramRow): void {
    try {
      if (!row || !row.nodes || row.nodes.length < 3) return;
      const items = this.db.getComprehensionRepo().getAll(repoPath);
      const nodes = applyComprehension(row.nodes, items);
      this.emit({
        type: 'skill:result',
        payload: {
          result: {
            skillName: 'visualize',
            type: 'diagram',
            narration: '', // the spoken briefing already plays; don't compete for the floor
            visualPayload: {
              target: row.title,
              kind: 'pipeline',
              // The flow's own narration travels here (not the spoken
              // `narration` field, which stays '' so it doesn't auto-play over
              // the briefing) so the ▶ replay button can re-speak it instantly.
              narration: row.narration ?? '',
              diagram: {
                scope: row.scope, view: 'logic',
                title: row.title, subtitle: row.subtitle,
                nodes, edges: row.edges,
              },
            },
          },
        },
      } as ServerEvent);
    } catch { /* best-effort — never block a briefing on the flow lookup */ }
  }

  private reemitBriefing(repoPath: string, briefingId: string, resumePrefix: string, asTurnResponse = false): void {
    const briefing = this.db.getBriefingRepo().get(repoPath, briefingId);
    if (!briefing) return;
    // Re-emits that are a reply to "go back" / "top" / "resume" are direct
    // responses — hold them through the silence window like any answer.
    if (asTurnResponse) this.currentTurnBriefingId = briefing.id;
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
        if (current) this.reemitBriefing(repoPath, current.briefingId, 'As I was saying', true);
        this.emit({
          type: 'visual:dispatch',
          payload: {
            transition: 'ASCEND',
            targetNodeId: current?.briefingId === 'project' || !current ? 'project' : current.briefingId,
            refs: [],
            reason: 'navigator pop',
          },
        });
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
        if (current) this.reemitBriefing(repoPath, current.briefingId, 'Back to the top', true);
        this.emit({
          type: 'visual:dispatch',
          payload: { transition: 'ASCEND', targetNodeId: 'project', refs: [], reason: 'navigator pop to project' },
        });
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
        // Voice verb → diagram: drilling by voice descends the canvas too.
        void this.dispatchAnswerVisual({ primaryTarget: target, refs: [target] });
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
        const codeEpoch = this.turnEpoch;
        (async () => {
          try {
            const resolved = await this.resolveCodeTarget(repoPath, target);
            if (!resolved) return;
            // The user moved on while we were resolving — don't narrate a
            // stale code walk over the new turn.
            if (this.turnEpoch !== codeEpoch) return;
            const { composeCodeBriefing } = await import('../briefing/code-composer.js');
            const result = composeCodeBriefing({
              repoPath,
              filePath: resolved.filePath,
              symbol: resolved.symbol,
            });
            if (!result) return;
            if (this.turnEpoch !== codeEpoch) return;
            this.deliverBriefing(result.briefing, 'user_asked');

            // Stream the code chunks WITH their line ranges so the
            // CodePanel can advance the highlight as Hermes speaks
            // each one. Without this, the panel just shows the file —
            // the "walk line by line" promise wouldn't be visible.
            if (result.chunks.length > 0) {
              const streamId = `code-${Date.now()}`;
              // Register as the live turn's stream so the chunks are held
              // (not dropped) if they land inside the silence window.
              this.currentTurnStreamId = streamId;
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
        this.reemitBriefing(repoPath, current.briefingId, 'Picking up where we left off', true);
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
    // The user speaking again supersedes anything held for the previous
    // floor closure — a fresh utterance (with a fresh ack) is coming.
    if (this.floorReleaseTimer) {
      clearTimeout(this.floorReleaseTimer);
      this.floorReleaseTimer = null;
    }
    this.discardPendingFloorNarration('superseded');
    // A direct-response briefing held for the previous floor closure is now
    // stale too — clear its marker and bump the epoch so async fast paths bail.
    this.currentTurnBriefingId = null;
    this.turnEpoch++;
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
    // Arm the release backstop: when the post-silence window expires with no
    // further emits (the lone held-ack case), drain the held chunks. Any
    // un-suppressed emit() beforehand drains them sooner, in order.
    if (this.floorReleaseTimer) clearTimeout(this.floorReleaseTimer);
    this.floorReleaseTimer = setTimeout(() => {
      this.floorReleaseTimer = null;
      this.flushPendingFloorNarration();
    }, this.POST_USER_SILENCE_MS + 20);
    this.floorReleaseTimer.unref?.();
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
    // Extracted to intelligence/code-target.ts so the grounding retriever
    // can reuse it; behavior unchanged.
    const { resolveCodeTarget } = await import('../intelligence/code-target.js');
    return resolveCodeTarget(repoPath, target, this.db.getContextCacheRepo());
  }

  private layerFromBriefingId(briefingId: string): ComprehensionItemLayer {
    if (briefingId === 'project') return 'project';
    if (briefingId === 'arch/root' || briefingId.startsWith('arch/')) return 'architecture';
    if (briefingId.startsWith('module/')) return 'module';
    if (briefingId.startsWith('file/')) return 'file';
    if (briefingId.startsWith('concept/')) return 'concept';
    return 'project';
  }

  /** Emit the FULL v3 comprehension signal (level + seen + quiz/grill)
   *  for one item, read fresh from the repo. The Overlay / Gaps panels
   *  consume this so they show the same model as the diagram instead
   *  of the legacy single `level`. */
  private emitComprehensionUpdate(
    repoPath: string,
    itemId: string,
    reason: 'briefing_delivered' | 'question_asked' | 'listened_through' | 'confirmed_phrase' | 'stale' | 'seen' | 'quiz' | 'grill' | 'qa_answer',
    previousLevel?: ComprehensionLevel,
  ): void {
    const item = this.db.getComprehensionRepo().get(repoPath, itemId);
    if (!item) return;
    this.emit({
      type: 'comprehension:updated',
      payload: {
        itemId: item.itemId,
        label: item.label,
        layer: item.layer,
        level: item.level,
        previousLevel: (previousLevel ?? item.level) as ComprehensionLevel,
        reason,
        seen: item.seen,
        grilled: item.grilled,
        quizCorrect: item.quizCorrect,
        quizTotal: item.quizTotal,
        grillStrong: item.grillStrong,
        grillAsked: item.grillAsked,
      },
    });
  }

  /** Observe a transition for a comprehension item, guarded by per-item
   *  cooldown. Emits the full v3 `comprehension:updated` after observe. */
  private observeComprehension(
    itemId: string,
    label: string,
    proposedLevel: ComprehensionLevel,
    reason: 'briefing_delivered' | 'question_asked' | 'listened_through' | 'stale' | 'qa_answer',
    opts: { secondsHeard?: number; questionsAsked?: number } = {},
  ) {
    const repoPath = this.activeRepoPath;
    if (!repoPath) return;

    const now = Date.now();
    const lastTouch = this.lastComprehensionTouchAt.get(itemId) ?? 0;
    // Cooldown applies to passive signals only — staleness degrade and
    // quiz/grill scoring are intentional and must always update.
    const bypassCooldown =
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

    // Emit the full v3 signal whenever we reach here (the cooldown
    // above already throttles passive spam). Not gated on level-move:
    // seen / quiz / grill change without moving level and the panels
    // must reflect that.
    this.emitComprehensionUpdate(repoPath, itemId, reason, (before?.level ?? 'unknown') as ComprehensionLevel);
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
    // Defensive: an utterance proves the user finished a speech segment. If a
    // user:speaking_stopped was lost in transit, userSpeaking would stay true
    // and hold the floor (suppressing this turn's answer) forever.
    if (this.userSpeaking) this.markUserSpeakingStopped();
    // Every utterance is a new turn: invalidate the previous turn's response
    // markers so a stale held briefing can't masquerade as this turn's answer.
    // (Covers typed/quick-chip turns that arrive with no speaking_started.)
    this.currentTurnBriefingId = null;
    this.turnEpoch++;
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

    // Depth unlock: a bare "tell me more" / "go deeper" right after an
    // answer was truncated at the sentence cap re-asks THAT question at the
    // deep tier. Must run before the navigator vocab, which would otherwise
    // swallow the phrase as a dive_deeper nav op. Guarded tightly: fresh
    // truncation (<2 min), a deep-pattern phrase, and nothing else in it.
    if (this.lastTruncated && Date.now() - this.lastTruncated.at < 120_000) {
      const { detectDepth } = await import('../intelligence/depth-modifiers.js');
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      const asksDeeper = detectDepth(text, 'normal').tier === 'deep';
      if (asksDeeper && wordCount <= 5) {
        const { question, params } = this.lastTruncated;
        this.lastTruncated = null;
        this.depthTier = 'deep';
        const streamId = `qa-${Date.now()}`;
        this.currentTurnStreamId = streamId;
        this.emit({
          type: 'narration:stream_chunk',
          payload: { streamId, seq: 0, text: 'Sure — going deeper now.', isFinal: false, referencedNodes: [] },
        });
        await this.handleQuestion(question, params, { streamId, startSeq: 1 });
        return;
      }
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

    // Agentic escalation: explicit "deep dive / dig through the code"
    // phrases, or an affirmative reply to a pending "want me to dig?"
    // offer. Runs after the deterministic fast paths (so the exact
    // quick-command "dive deeper" keeps its navigation meaning) and
    // before classification (no LLM needed to route it).
    const { shouldEscalateToAgentic, isEscalationAffirmative } = await import('./qa-router.js');
    if (this.pendingEscalation && Date.now() < this.pendingEscalation.expiresAt && isEscalationAffirmative(text)) {
      const pendingQ = this.pendingEscalation.question;
      this.pendingEscalation = null;
      await this.runAgenticAnswer(pendingQ);
      return;
    }
    this.pendingEscalation = null; // any non-affirmative utterance drops the offer
    if (shouldEscalateToAgentic(text)) {
      await this.runAgenticAnswer(text);
      return;
    }

    // From here every route involves an LLM (classify and/or answer) — dead
    // air territory. Speak an instant ack as seq 0 of this turn's answer
    // stream BEFORE classification so the user hears a response within
    // ~300ms instead of ~3s+. Depth detection runs first (pure regex):
    // its ack replaces the generic one, never two acks, and the tier
    // update applies to ALL routes (skills included), not just Q&A.
    const { detectDepth } = await import('../intelligence/depth-modifiers.js');
    const { pickAck } = await import('./ack-phrases.js');
    const depthSignal = detectDepth(text, this.depthTier);
    this.depthTier = depthSignal.tier;
    const impliesBrevity = /\b\d+\s+(words?|sentences?|lines?|paragraphs?)\b|\b(brief|brevity|short|terse|concise|tldr|tl;dr|one[\s-]?liner|in\s+a?\s*sentence)\b/i.test(text);
    const ackText = depthSignal.changed && !impliesBrevity
      ? (depthSignal.tier === 'tldr' ? "Got it — I'll keep it short." : 'Sure — going deeper now.')
      : pickAck(text, this.lastAck);
    const turnStreamId = `qa-${Date.now()}`;
    this.currentTurnStreamId = turnStreamId;
    this.lastAck = ackText;
    this.emit({
      type: 'narration:stream_chunk',
      payload: { streamId: turnStreamId, seq: 0, text: ackText, isFinal: false, referencedNodes: [] },
    });
    const turnOpts = { streamId: turnStreamId, startSeq: 1 };

    // If no intent classifier available, fall back to treating it as a question
    if (!this.intentClassifier) {
      this.handleQuestion(text, {}, turnOpts);
      return;
    }

    // Build context string for the classifier
    const currentArea = this.state.areaIndex !== undefined ? this.areas[this.state.areaIndex] : undefined;
    const contextStr = `Phase: ${this.state.phase}. Area: ${currentArea?.name ?? 'none'}. Areas: ${this.areas.map(a => a.name).join(', ')}.`;

    const classification = await this.intentClassifier.classify(text, contextStr);

    // Tagged log for debug-recorder review. One greppable line per
    // user utterance → classifier decision, so we can correlate "the
    // app did X" against "this is what the classifier picked" without
    // having to instrument again on each diagnostic round.
    // eslint-disable-next-line no-console
    console.log(`[trace] classify "${text.slice(0, 80)}" -> skill=${classification.skillName} conf=${classification.confidence.toFixed(2)} params=${JSON.stringify(classification.params)} phase=${this.state.phase}`);

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
      this.handleQuestion(text, classification.params, turnOpts);
      return;
    }

    // Low confidence -- also route to general conversation. The
    // classifier was told to prefer 'none' when uncertain, but when it
    // still hedges below 0.7 we trust the conversational handler over a
    // forced skill rather than asking for clarification (the user just
    // told us what they want; making them rephrase is bad UX).
    if (classification.confidence < 0.7) {
      this.handleQuestion(text, classification.params, turnOpts);
      return;
    }

    // Execute the skill -- requires an active analyzer
    if (!this.activeAnalyzer) {
      this.handleQuestion(text, {}, turnOpts);
      return;
    }

    await this.executeSkillWithDeviation(classification.skillName as SkillName, classification.params, currentArea, {
      ...turnOpts,
      utterance: text,
    });
  }

  private async executeSkillWithDeviation(
    skillName: SkillName,
    params: Record<string, string>,
    currentArea?: AreaWithContent,
    streamOpts?: { streamId: string; startSeq: number; utterance?: string },
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
      const fullResult = await this.skillRegistry.execute(
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
          cacheRepo: this.db.getContextCacheRepo(),
          diagramRepo: this.db.getDiagramCacheRepo(),
        },
        params,
      );
      // The live stream handle is backend-only — never serialize it.
      const { narrationStream, ...result } = fullResult;

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
      if (narrationStream) {
        // Live-streamed skill narration (explain): sentences speak as they
        // generate; the cap aborts the stream + appends the steering hook.
        const { sentenceCap } = await import('../intelligence/depth-modifiers.js');
        const { streamAnswerToChunks } = await import('./answer-streamer.js');
        const { parseRefsLine } = await import('../intelligence/answer-refs.js');
        const nodeLabels = await this.knownNodeLabels();
        const streamId = streamOpts?.streamId ?? `nar-${Date.now()}`;
        const anchorHits = new Set<string>();
        let artifactCount = 0;
        const sr = await streamAnswerToChunks(narrationStream, {
          streamId,
          startSeq: streamOpts?.startSeq ?? 0,
          nodeLabels,
          maxSentences: sentenceCap(this.depthTier),
          emitChunk: c => {
            for (const r of c.referencedNodes) anchorHits.add(r);
            this.emit({
              type: 'narration:stream_chunk',
              payload: { streamId, seq: c.seq, text: c.text, isFinal: c.isFinal, referencedNodes: c.referencedNodes },
            });
          },
          onArtifact: a => this.emitArtifact(`${streamId}-a${artifactCount++}`, a),
        });
        this.lastTruncated = sr.truncated && streamOpts?.utterance
          ? { question: streamOpts.utterance, params, at: Date.now() }
          : sr.truncated ? this.lastTruncated : null;
        const primaryTarget = result.diagramChanges?.focusNodeId
          ?? ((result.visualPayload as Record<string, unknown> | undefined)?.target as string | undefined);
        void this.dispatchAnswerVisual({
          primaryTarget,
          refs: [...parseRefsLine(sr.refsLine), ...anchorHits],
          question: streamOpts?.utterance,
        });
      } else if (result.narration && result.narration.trim().length > 0) {
        // Skill narrations get the same hard cap + steering hook as Q&A
        // answers (post-hoc truncation — skills still produce complete
        // strings). Joining the turn stream keeps the spoken ack and the
        // narration in one transcript entry. REFS lines are stripped
        // before speech and feed the visual dispatch below.
        const { sentenceCap } = await import('../intelligence/depth-modifiers.js');
        const { extractRefs } = await import('../intelligence/answer-refs.js');
        const { clean, refs } = extractRefs(result.narration);
        const { truncated } = await this.emitNarrationChunked(clean, {
          streamId: streamOpts?.streamId,
          startSeq: streamOpts?.startSeq,
          capSentences: sentenceCap(this.depthTier),
        });
        this.lastTruncated = truncated && streamOpts?.utterance
          ? { question: streamOpts.utterance, params, at: Date.now() }
          : truncated ? this.lastTruncated : null;
        // Visual pairing for skills. The visualize skill with an authored
        // diagram already swaps the whole payload — don't fight it.
        const authoredDiagram = result.skillName === 'visualize'
          && !!(result.visualPayload as Record<string, unknown> | undefined)?.diagram;
        if (!authoredDiagram) {
          const primaryTarget = result.diagramChanges?.focusNodeId
            ?? ((result.visualPayload as Record<string, unknown> | undefined)?.target as string | undefined);
          void this.dispatchAnswerVisual({ primaryTarget, refs, question: streamOpts?.utterance });
        }
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
      //
      // Two live-session bug fixes (2026-06-09):
      //  - STREAMED skills carry narration:'' — they were misread as
      //    "silent" and got the nudge stacked right onto their answer;
      //  - explore mode has NO tour to go "back to" — the nudge was
      //    meaningless noise there, and worse, speaking the literal
      //    phrase 'say "back to the tour"' got echo-transcribed 12s
      //    later and SELF-EXECUTED resumeTour (phase flap).
      const skillWasSilent = !narrationStream && (!result.narration || result.narration.trim().length === 0);
      if (
        skillWasSilent &&
        this.entryMode !== 'explore' &&
        this.tourPlan?.isInDeviation() &&
        !this.tourPlan.hasCheckedIn()
      ) {
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

  /** Accept the proposal and transition to the first tour phase.
   *  SILENT by design — the canned "Go ahead." here used to fire whenever
   *  the user spoke during PROPOSAL, reading as a glitch right at the
   *  start of every session. */
  private acceptProposal(): void {
    if (this.entryMode === 'explore') {
      // Explore mode: show architecture and wait. User leads.
      this.setVisualLayer(3);
      this.setState({ phase: 'OVERVIEW' });
    } else if (this.entryMode === 'full_walkthrough') {
      this.setState({ phase: 'PROJECT_OVERVIEW' });
      this.setVisualLayer(1);
    } else {
      // Updates mode: go through PREVIOUSLY_ON or straight to HEATMAP
      if (this.previousSession) {
        this.setState({ phase: 'PREVIOUSLY_ON' });
        const narrative = this.previousSession.summary
          ?? `Last session reviewed ${this.previousSession.totalAreas} areas with ${this.previousSession.totalCommits} commits.`;
        this.emit({
          type: 'session:recap',
          payload: { previousSession: this.previousSession, narrative },
        });
        // Backend-spoken (the frontend used to speak this via a side
        // channel that raced the streamed narration).
        void this.emitNarrationChunked(narrative);
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

    // Narrate the resume as the current turn's stream so it's held (not
    // dropped) if the user's "back to the tour" lands in the silence window.
    const streamId = `nav-${Date.now()}`;
    this.currentTurnStreamId = streamId;
    this.emit({
      type: 'narration:stream_chunk',
      payload: { streamId, seq: 0, text: resumeMessage, isFinal: true, referencedNodes: [] },
    });

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

/** First N sentences of a briefing opener — the short session greeting. */
/** A real comprehension item carries a canonical layer prefix. Bare authored
 *  flow-node ids ('data-cleaner') are not items and must never spawn rows. */
function isCanonicalItemId(id: string): boolean {
  return id === 'project' || /^(module|file|arch|concept)\//.test(id);
}

function firstSentences(text: string | undefined, n: number): string {
  if (!text) return '';
  return text.split(/(?<=[.!?])\s+/).slice(0, n).join(' ').trim();
}

/** Spoken-friendly date: "June 2nd", or "today"/"yesterday" when close. */
function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'last time';
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'earlier today';
  if (days === 1) return 'yesterday';
  const month = d.toLocaleString('en-US', { month: 'long' });
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st'
    : day % 10 === 2 && day !== 12 ? 'nd'
    : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${month} ${day}${suffix}`;
}
