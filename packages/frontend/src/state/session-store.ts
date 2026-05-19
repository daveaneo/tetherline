import { create } from 'zustand';
import type {
  SessionState, StateContext, ServerEvent, AreaWithContent,
  AnalysisProgress, Concern, HeatmapData, SessionSummary, UnderstandingState,
  SkillResult, VisualLayer, ConceptualStep,
  ComprehensionLevel, NarrationSegment,
} from '@tetherline/shared';
import { DEFAULT_MODES } from '@tetherline/shared';
import { useAudioStore } from './audio-store.js';
import type { DiagramPayload } from '../components/room/diagram-types.js';

/** Per-turn snapshot of the visual state. Drives the time slider that
 *  lets the user scrub back to any prior moment in the conversation
 *  and rehydrate the diagram to that point. */
export interface TurnSnapshot {
  turnIndex: number;
  timestamp: number;
  /** What the user said (or '' for AI-initiated turns like the welcome). */
  question: string;
  /** What the AI said (the full assembled answer). */
  answer: string;
  /** Diagram scope active when this turn ended. */
  scope: string;
  /** Node ids referenced anywhere in the AI's answer — used to:
   *  (a) compute the persistent "touched" halo set,
   *  (b) thumbnail the history cards. */
  referencedNodes: string[];
}

interface ProposalData {
  message: string;
  suggestedOrder: string[];
  areas: Array<{ id: string; name: string; significance: string }>;
}

export interface ConversationEntry {
  speaker: 'ai' | 'you';
  text: string;
  timestamp: number;
}

interface SessionStore {
  state: SessionState;
  context: StateContext;
  areas: AreaWithContent[];
  activeRepoPath: string;
  entryMode: string;
  analysisProgress: AnalysisProgress | null;
  heatmap: HeatmapData | null;
  concerns: Concern[];
  previousSession: SessionSummary | null;
  recap: string | null;
  greeting: string | null;
  proposal: ProposalData | null;
  qaAnswer: string;
  qaAnswerDone: boolean;
  understanding: UnderstandingState | null;
  skillResult: SkillResult | null;
  /** Which concern is active in a ranked `critique` result. Drives the
   *  card's expanded row and the (active-only) diagram tint. */
  critiqueActiveIndex: number;
  skillClarification: { message: string; options: string[] } | null;
  visualLayer: VisualLayer;
  conceptualSteps: ConceptualStep[];
  tourProgress: { total: number; covered: number; percentage: number } | null;
  lastIssueResult: { url: string; number: number } | null;
  error: { code: string; message: string; recoverable: boolean } | null;
  connected: boolean;
  conversationHistory: ConversationEntry[];

  /** Turn-by-turn visual snapshots — drives the time slider + history
   *  thumbnails. Appended to whenever a stream completes. */
  turnSnapshots: TurnSnapshot[];

  /** Set of node ids the user has "touched" this session (referenced
   *  in any AI reply). Drives the persistent halo effect — touched
   *  nodes get a brighter base color forever after, so the diagram
   *  becomes a heat-map of the user's attention as the conversation
   *  progresses. */
  touchedNodes: Set<string>;
  /** DEV scene harness: when set, HermesDiagram renders THIS payload
   *  deterministically and skips the /api/diagram fetch + WS/backend.
   *  Always null in production (no scene param → never set). */
  sceneDiagramPayload: DiagramPayload | null;
  /** Active deep_dive pocket (B14/B16). null when not inside a pocket.
   *  Set by the deep_dive orchestrator (and scene fixtures). The pocket
   *  is its OWN state — never a skill annotation — so it carries its
   *  composed slides directly; when `slides` is present the pocket takes
   *  over the canvas (presentation), otherwise only the position trail
   *  shows over the diagram. */
  breadcrumbPocket:
    | { focus?: string; slide: number; total: number; slides?: { title: string; body: string }[] }
    | null;
  /** Active pipeline walkthrough (B3). null when not walking a flow.
   *  `step` = how many stages have been revealed so far (1..N) in
   *  source→transform→guard→sink order; HermesDiagram derives the
   *  order from the cached graph via the tested pipelineRevealOrder
   *  core and dims the not-yet-revealed nodes. NOT a skill annotation
   *  — it's its own walkthrough state. */
  pipelineReveal: { step: number } | null;
  /** Active blast-radius query (B4). null when not asking impact.
   *  `changedId` is the node whose ripple is shown; HermesDiagram
   *  derives concentric hop rings via the tested blastRadiusRings
   *  core. Its own query state — not a skill annotation. */
  blastRadius: { changedId: string } | null;
  /** Active guided-learning tour (B15). null when not in guided mode.
   *  Mirrors the tested TourPlan shape (items + currentIndex) — the
   *  spine is computed by TourPlan.fromArchitecture on the backend and
   *  the already-ordered steps are surfaced here; HermesDiagram only
   *  renders the position. Its own mode state, not a skill annotation. */
  guidedTour:
    | { items: { name: string; type: string; covered: boolean }[]; currentIndex: number }
    | null;
  /** v2 weak-spot review loop: open (unresolved) "study this" items —
   *  weak/partial quiz/grill questions. Surfaced on the focused layer;
   *  resolvable from the WeakSpotsPanel. */
  weakSpots: { itemId: string; question: string; source: 'grill' | 'quiz' }[];
  /** DEV/scene-only: forces the weak-spots panel open so the expanded
   *  state is deterministically screenshot-able. Never set in prod. */
  sceneForceWeakSpotsOpen: boolean;

  // ─── Vision mechanics ────────────────────────────────────
  currentBriefing: {
    briefingId: string;
    layer: string;
    title: string;
    text: string;
    estimatedSeconds: number;
    talkingPoints: string[];
    children: string[];
    parent: string | null;
    resumePrefix?: string;
    receivedAt: number;
  } | null;
  breadcrumb: {
    text: string;
    depth: number;
    frames: Array<{ briefingId: string; title: string; layer: string }>;
  };
  comprehensionMap: Map<string, {
    level: ComprehensionLevel; label: string; layer: string;
    // v3 knowledge signal — so the Overlay / Gaps panels render the
    // same Seen + Quiz/Grill model as the diagram (structurally a
    // shared `Leveled`). Optional ⇒ tolerates pre-v3 emits.
    seen?: boolean; grilled?: boolean;
    quizCorrect?: number; quizTotal?: number;
    grillStrong?: number; grillAsked?: number;
  }>;
  quickPreview: {
    repoName: string;
    commitCount: number;
    contributors: Array<{ name: string; commits: number }>;
    topFolders: Array<{ path: string; fileCount: number }>;
    topFiles: Array<{ path: string; touches: number }>;
  } | null;
  streamedNarratives: Map<string, { areaId: string; narrativeText: string; segments: NarrationSegment[] }>;
  /** Cross-session recall: distinct user questions from prior sessions on
   *  this repo. Surfaced in the GapsPanel so the user can pick up where
   *  they left off last time. */
  recallQuestions: string[];
  /** Comprehension items the user previously engaged with — used for
   *  the GapsPanel "Pick up where you left off" section. Each entry
   *  carries the prior level + commits-since-last-touch so the user
   *  knows whether the code has drifted while they were away. */
  recallItems: Array<{
    itemId: string;
    label: string;
    layer: string;
    level: ComprehensionLevel;
    commitsSinceLastTouch: number;
  }>;
  /** Active streamed answer chunks. Each entry is a complete sentence/group
   *  the orchestrator plays sequentially via TTS. The orchestrator removes
   *  entries via `consumeStreamChunk` once it starts speaking that chunk —
   *  so the queue length tracks unspoken backlog. `streamingFinal` flips on
   *  the last chunk so the orchestrator knows when to stop the player. */
  streamChunks: Array<{ streamId: string; seq: number; text: string; range?: [number, number]; filePath?: string; referencedNodes?: string[] }>;
  streamingFinal: boolean;
  /** The chunk currently being spoken. Written by the orchestrator's
   *  stream player — `consumeStreamChunk` returns the head AND records
   *  it here so the CodePanel can highlight the live line range. */
  currentStreamChunk: { streamId: string; seq: number; text: string; range?: [number, number]; filePath?: string; referencedNodes?: string[] } | null;
  consumeStreamChunk: () => { streamId: string; seq: number; text: string; range?: [number, number]; filePath?: string; referencedNodes?: string[] } | null;
  showComprehensionOverlay: boolean;
  toggleComprehensionOverlay: () => void;

  handleServerEvent: (event: ServerEvent) => void;
  /** Select a concern in a ranked critique. Re-speaks its detail via
   *  the existing greeting TTS path — no LLM call, no voice routing. */
  setCritiqueActive: (index: number) => void;
  addConversation: (speaker: 'ai' | 'you', text: string) => void;
  clearError: () => void;
  setConnected: (v: boolean) => void;
  resetSession: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  state: { phase: 'IDLE' },
  context: { sessionId: '', totalAreas: 0, modes: { ...DEFAULT_MODES }, concerns: [] },
  areas: [],
  activeRepoPath: '',
  entryMode: '',
  analysisProgress: null,
  heatmap: null,
  concerns: [],
  previousSession: null,
  recap: null,
  greeting: null,
  proposal: null,
  qaAnswer: '',
  qaAnswerDone: false,
  understanding: null,
  skillResult: null,
  critiqueActiveIndex: 0,
  sceneDiagramPayload: null,
  breadcrumbPocket: null,
  pipelineReveal: null,
  blastRadius: null,
  guidedTour: null,
  weakSpots: [],
  sceneForceWeakSpotsOpen: false,
  skillClarification: null,
  visualLayer: 1 as VisualLayer,
  conceptualSteps: [],
  tourProgress: null,
  lastIssueResult: null,
  error: null,
  connected: false,
  conversationHistory: [],
  turnSnapshots: [],
  touchedNodes: new Set<string>(),
  currentBriefing: null,
  breadcrumb: { text: '', depth: 0, frames: [] },
  comprehensionMap: new Map(),
  quickPreview: null,
  streamedNarratives: new Map(),
  recallQuestions: [],
  recallItems: [],
  streamChunks: [],
  streamingFinal: false,
  currentStreamChunk: null,
  consumeStreamChunk: () => {
    const chunks = get().streamChunks;
    if (chunks.length === 0) return null;
    const [head, ...rest] = chunks;
    set({ streamChunks: rest, currentStreamChunk: head });
    return head;
  },
  showComprehensionOverlay: false,

  toggleComprehensionOverlay: () => set(s => ({ showComprehensionOverlay: !s.showComprehensionOverlay })),

  // Dedupe consecutive same-speaker / same-text entries. Backend emits
  // both `narration:greeting` and `narration:briefing` (or two
  // briefings) with identical text on warm-cache replay, which was
  // showing as "AI / AI" duplicates in the conversation log.
  addConversation: (speaker, text) => set(s => {
    const last = s.conversationHistory[s.conversationHistory.length - 1];
    if (last && last.speaker === speaker && last.text === text) return s;
    return {
      conversationHistory: [...s.conversationHistory.slice(-49), { speaker, text, timestamp: Date.now() }],
    };
  }),

  setCritiqueActive: (index: number) => set(s => {
    const concerns = s.skillResult?.visualPayload?.concerns as
      | Array<{ detail?: string }>
      | undefined;
    if (!Array.isArray(concerns) || concerns.length === 0) return s;
    const i = Math.max(0, Math.min(index, concerns.length - 1));
    if (i === s.critiqueActiveIndex) return s;
    const detail = concerns[i]?.detail;
    // Re-speaking is the existing greeting TTS path picking up a new
    // value — no backend call, classifier, or voice-routing involved.
    return typeof detail === 'string' && detail.trim()
      ? { critiqueActiveIndex: i, greeting: detail }
      : { critiqueActiveIndex: i };
  }),

  clearError: () => set({ error: null }),
  setConnected: (v: boolean) => set({ connected: v }),

  resetSession: () => set({
    state: { phase: 'IDLE' },
    context: { sessionId: '', totalAreas: 0, modes: { ...DEFAULT_MODES }, concerns: [] },
    areas: [],
    activeRepoPath: '',
  entryMode: '',
    analysisProgress: null,
    heatmap: null,
    concerns: [],
    previousSession: null,
    recap: null,
    greeting: null,
    proposal: null,
    qaAnswer: '',
    qaAnswerDone: false,
    understanding: null,
    skillResult: null,
    critiqueActiveIndex: 0,
    skillClarification: null,
    visualLayer: 1 as VisualLayer,
    conceptualSteps: [],
    tourProgress: null,
    lastIssueResult: null,
    error: null,
    conversationHistory: [],
    turnSnapshots: [],
    touchedNodes: new Set<string>(),
    currentBriefing: null,
    breadcrumb: { text: '', depth: 0, frames: [] },
    comprehensionMap: new Map(),
    quickPreview: null,
    streamedNarratives: new Map(),
    recallQuestions: [],
  recallItems: [],
  streamChunks: [],
  streamingFinal: false,
  currentStreamChunk: null,
  consumeStreamChunk: () => {
    const chunks = get().streamChunks;
    if (chunks.length === 0) return null;
    const [head, ...rest] = chunks;
    set({ streamChunks: rest, currentStreamChunk: head });
    return head;
  },
    showComprehensionOverlay: false,
  }),

  handleServerEvent: (event: ServerEvent) => {
    switch (event.type) {
      case 'analysis:started':
        set({ analysisProgress: { phase: 'reading_commits', progress: 0, message: 'Starting analysis...' } });
        break;

      case 'analysis:progress':
        set({ analysisProgress: event.payload });
        break;

      case 'analysis:area_ready': {
        const area = event.payload.area;
        const areaWithContent: AreaWithContent = {
          ...area,
          narrationSegments: [],
          architectureNodes: [],
          architectureEdges: [],
          deepDiveGenerated: false,
          reviewed: false,
        } as AreaWithContent;
        set(s => ({ areas: [...s.areas, areaWithContent] }));
        break;
      }

      case 'analysis:complete':
        set({
          areas: event.payload.areas,
          analysisProgress: { phase: 'complete', progress: 1, message: 'Complete' },
        });
        break;

      case 'session:state_changed': {
        const stateUpdate: Partial<SessionStore> = { state: event.payload.state, context: event.payload.context };
        // Sync visualLayer from session state if present
        if (event.payload.state.visualLayer) {
          stateUpdate.visualLayer = event.payload.state.visualLayer;
        }
        set(stateUpdate);
        break;
      }

      case 'session:recap':
        set({ previousSession: event.payload.previousSession, recap: event.payload.narrative });
        break;

      case 'session:recall':
        set({
          recallQuestions: event.payload.questions,
          recallItems: event.payload.items ?? [],
        });
        break;

      case 'narration:stream_chunk': {
        // Streamed answer chunks queue up for sequential TTS playback —
        // chunk N starts speaking while chunk N+1 is still TTS-generating,
        // dropping perceived first-word time on long answers. Code-layer
        // chunks also carry the line range + filePath so the CodePanel
        // can advance the highlight live as Hermes walks each one.
        // Echo-gate signal: stamp lastNarrationAt so transcripts
        // arriving inside the echo window get suppressed (the AI's TTS
        // is about to play; any mic capture is speaker-bleed).
        useAudioStore.getState().setLastNarrationAt(Date.now());
        const { streamId, seq, text, isFinal, range, filePath, referencedNodes } = event.payload;
        set(s => {
          // First chunk of a new stream resets the prior queue + final flag.
          const isNewStream = s.streamChunks.length === 0
            || s.streamChunks[0].streamId !== streamId;
          const queue = isNewStream
            ? [{ streamId, seq, text, range, filePath, referencedNodes }]
            : [...s.streamChunks, { streamId, seq, text, range, filePath, referencedNodes }];
          const updates: Partial<SessionStore> = {
            streamChunks: queue,
            streamingFinal: isFinal,
          };
          if (isFinal) {
            // Conversation transcript: log the full assembled answer.
            const fullText = queue.map(c => c.text).join(' ');
            updates.conversationHistory = [
              ...s.conversationHistory.slice(-49),
              { speaker: 'ai', text: fullText, timestamp: Date.now() },
            ];
            // Turn snapshot for the time slider + history thumbnails.
            // Pull the previous user utterance (last 'you' entry) to
            // pair the AI answer with its question.
            const lastUser = [...s.conversationHistory].reverse().find(e => e.speaker === 'you');
            const allReferenced = new Set<string>();
            for (const c of queue) {
              for (const n of c.referencedNodes ?? []) allReferenced.add(n);
            }
            const snapshot: TurnSnapshot = {
              turnIndex: s.turnSnapshots.length,
              timestamp: Date.now(),
              question: lastUser?.text ?? '',
              answer: fullText,
              scope: 'project', // tracked elsewhere; placeholder for v1
              referencedNodes: [...allReferenced],
            };
            updates.turnSnapshots = [...s.turnSnapshots, snapshot];
            // Persistent halo: union into the touchedNodes set so the
            // diagram renders these nodes brighter forever after.
            const merged = new Set(s.touchedNodes);
            for (const n of allReferenced) merged.add(n);
            updates.touchedNodes = merged;
          }
          return updates;
        });
        break;
      }

      case 'session:proposal': {
        const proposalPayload = event.payload as ProposalData & { conceptualSteps?: ConceptualStep[] };
        const updates: Partial<SessionStore> = { proposal: proposalPayload };
        if (proposalPayload.conceptualSteps?.length) {
          updates.conceptualSteps = proposalPayload.conceptualSteps;
        }
        set(updates);
        break;
      }

      case 'session:heatmap':
        set({ heatmap: event.payload.heatmap });
        break;

      case 'advisory:concern':
      case 'advisory:alert':
        set(s => ({ concerns: [...s.concerns, event.payload.concern] }));
        break;

      case 'qa:answer_chunk':
        set(s => ({
          qaAnswer: event.payload.done ? event.payload.text : s.qaAnswer + event.payload.text,
          qaAnswerDone: event.payload.done,
        }));
        if (event.payload.done) {
          get().addConversation('ai', event.payload.text);
        }
        break;

      case 'narration:greeting':
        // Echo-gate signal — see narration:stream_chunk handler.
        useAudioStore.getState().setLastNarrationAt(Date.now());
        set({ greeting: event.payload.text });
        get().addConversation('ai', event.payload.text);
        break;

      case 'session:understanding':
        set({ understanding: event.payload.understanding });
        break;

      case 'skill:result':
        set({ skillResult: event.payload.result, critiqueActiveIndex: 0, skillClarification: null });
        if (event.payload.result.narration) {
          get().addConversation('ai', event.payload.result.narration);
        }
        break;

      case 'skill:clarify':
        set({ skillClarification: event.payload });
        break;

      case 'session:tour_progress':
        set({ tourProgress: event.payload });
        break;

      case 'visual:layer_change':
        set({ visualLayer: (event.payload as { layer: VisualLayer }).layer });
        break;

      case 'action:issue_created':
        set({ lastIssueResult: event.payload as { url: string; number: number } });
        break;

      case 'action:issue_failed':
        set({ error: { code: 'ISSUE_FAILED', message: (event.payload as { error: string }).error, recoverable: true } });
        break;

      case 'error':
        console.error('Server error:', event.payload);
        set({ error: event.payload });
        break;

      case 'narration:briefing':
        // Echo-gate signal — see narration:stream_chunk handler.
        useAudioStore.getState().setLastNarrationAt(Date.now());
        set({
          currentBriefing: {
            briefingId: event.payload.briefingId,
            layer: event.payload.layer,
            title: event.payload.title,
            text: event.payload.text,
            estimatedSeconds: event.payload.estimatedSeconds,
            talkingPoints: event.payload.talkingPoints,
            children: event.payload.children,
            parent: event.payload.parent,
            resumePrefix: event.payload.resumePrefix,
            receivedAt: Date.now(),
          },
          greeting: event.payload.text,
        });
        get().addConversation('ai', event.payload.text);
        break;

      case 'navigator:push':
        set(s => ({
          breadcrumb: {
            text: event.payload.breadcrumb,
            depth: event.payload.depth,
            frames: [...s.breadcrumb.frames, {
              briefingId: event.payload.briefingId,
              title: s.currentBriefing?.title ?? event.payload.briefingId,
              layer: s.currentBriefing?.layer ?? 'unknown',
            }],
          },
        }));
        break;

      case 'navigator:pop':
        set(s => ({
          breadcrumb: {
            text: event.payload.breadcrumb,
            depth: event.payload.depth,
            frames: s.breadcrumb.frames.slice(0, event.payload.depth),
          },
        }));
        break;

      case 'navigator:breadcrumb':
        set({
          breadcrumb: {
            text: event.payload.breadcrumb,
            depth: event.payload.depth,
            frames: event.payload.frames,
          },
        });
        break;

      case 'comprehension:updated':
        set(s => {
          const next = new Map(s.comprehensionMap);
          const p = event.payload;
          next.set(p.itemId, {
            level: p.level,
            label: p.label,
            layer: p.layer,
            seen: p.seen,
            grilled: p.grilled,
            quizCorrect: p.quizCorrect,
            quizTotal: p.quizTotal,
            grillStrong: p.grillStrong,
            grillAsked: p.grillAsked,
          });
          return { comprehensionMap: next };
        });
        break;

      case 'session:quick_preview':
        set({ quickPreview: event.payload });
        break;

      case 'analysis:area_narrative_ready':
        set(s => {
          const next = new Map(s.streamedNarratives);
          next.set(event.payload.areaId, event.payload);
          return { streamedNarratives: next };
        });
        break;

      default:
        // Other events handled by specific components
        break;
    }
  },
}));
