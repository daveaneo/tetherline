import type { AnalysisProgress, Area, AreaWithContent, NarrationSegment, DiagramNode, DiagramEdge } from './analysis.js';
import type { Concern } from './concerns.js';
import type { HeatmapData } from './heatmap.js';
import type { SessionModes, ModeKey, EntryMode } from './modes.js';
import type { Session, SessionSummary } from './session.js';
import type { UnderstandingState } from './understanding.js';
import type { SkillResult } from './skills.js';
import type { VisualLayer } from './visual-layer.js';
import type { VisualTransition } from './visual-dispatch.js';
import type { OnboardingDay } from './onboarding.js';

// Client → Server
export type ClientEvent =
  | { type: 'session:start'; payload: { repoPath: string; sinceDays?: number; entryMode?: EntryMode } }
  | { type: 'session:resume'; payload: { sessionId: string } }
  | { type: 'command:next' }
  | { type: 'command:previous' }
  | { type: 'command:dive_deeper' }
  | { type: 'command:level_up' }
  | { type: 'command:skip' }
  | { type: 'command:pause' }
  | { type: 'command:resume' }
  | { type: 'command:ask'; payload: { question: string } }
  | { type: 'command:force_skill'; payload: { skillName: string; params?: Record<string, string> } }
  | { type: 'command:toggle_mode'; payload: { mode: ModeKey; enabled: boolean } }
  | { type: 'command:export'; payload: { format: 'slides' | 'markdown' } }
  | { type: 'command:quiz_start' }
  | { type: 'user:quiz_answer'; payload: { questionId: string; answer: string } }
  | { type: 'audio:segment_finished'; payload: { segmentId: string } }
  | { type: 'user:utterance'; payload: { text: string; timestamp: number } }
  | { type: 'user:speaking_started' }
  | { type: 'user:speaking_stopped' }
  | { type: 'action:confirm_issue'; payload: { title: string; body: string; labels: string[] } }
  | { type: 'session:start_onboarding'; payload: { repoPath: string; programId?: string; dayNumber?: number } }
  // Frontend mirrors its local diagram scope so the visual dispatcher can
  // classify DESCEND vs ASCEND vs LATERAL correctly server-side.
  | { type: 'diagram:scope'; payload: { scope: string } };

// Server → Client
export type ServerEvent =
  | { type: 'analysis:started'; payload: { sessionId: string } }
  | { type: 'analysis:progress'; payload: AnalysisProgress }
  | { type: 'analysis:area_ready'; payload: { area: Area } }
  | { type: 'analysis:area_narrative_ready'; payload: { areaId: string; narrativeText: string; segments: NarrationSegment[] } }
  | { type: 'analysis:complete'; payload: { summary: SessionSummary; areas: AreaWithContent[] } }
  | { type: 'session:quick_preview'; payload: {
      repoName: string;
      commitCount: number;
      contributors: Array<{ name: string; commits: number }>;
      topFolders: Array<{ path: string; fileCount: number }>;
      topFiles: Array<{ path: string; touches: number }>;
      sinceDate: string;
      untilDate: string;
    } }
  | { type: 'narration:quick_answer'; payload: { question: string; answer: string; source: string } }
  | { type: 'narration:briefing'; payload: {
      briefingId: string;
      layer: 'project' | 'architecture' | 'module' | 'file' | 'concept' | 'code';
      title: string;
      text: string;                      // the opener (TTS-ready)
      estimatedSeconds: number;
      talkingPoints: string[];
      children: string[];
      parent: string | null;
      cacheHit: boolean;                 // true = served from briefings table; false = LLM fallback
      resumePrefix?: string;             // if set, prepend "As I was saying..." when TTS plays
      /** false = the visual/navigator effects apply but the frontend must
       *  NOT speak `text` — its spoken form travels elsewhere (e.g. the
       *  session-open stream). Default true. Without this, the session-
       *  start briefing raced the opener stream on the greeting lane and
       *  cut "Welcome back…" off mid-word (live 2026-06-12). */
      spoken?: boolean;
    } }
  | { type: 'navigator:push'; payload: {
      briefingId: string;
      depth: number;
      breadcrumb: string;
      hint?: string;
    } }
  | { type: 'navigator:pop'; payload: {
      poppedBriefingId: string;
      currentBriefingId: string | null;
      depth: number;
      breadcrumb: string;
    } }
  | { type: 'navigator:breadcrumb'; payload: {
      breadcrumb: string;
      depth: number;
      frames: Array<{ briefingId: string; title: string; layer: string }>;
    } }
  | { type: 'comprehension:updated'; payload: {
      itemId: string;
      label: string;
      layer: string;
      level: 'unknown'|'mentioned'|'heard'|'engaged'|'explained'|'confirmed';
      previousLevel: 'unknown'|'mentioned'|'heard'|'engaged'|'explained'|'confirmed';
      reason: 'briefing_delivered'|'question_asked'|'listened_through'|'confirmed_phrase'|'stale'|'seen'|'quiz'|'grill'|'qa_answer';
      // v3 knowledge signal — carried so the Overlay / Gaps panels show
      // the SAME Seen + Quiz/Grill model as the diagram (not the old
      // single `level`). Optional ⇒ backward-compatible.
      seen?: boolean;
      grilled?: boolean;
      quizCorrect?: number;
      quizTotal?: number;
      grillStrong?: number;
      grillAsked?: number;
    } }
  | { type: 'session:state_changed'; payload: { state: SessionState; context: StateContext } }
  | { type: 'session:recap'; payload: { previousSession: SessionSummary; narrative: string } }
  | { type: 'session:recall'; payload: {
      /** Distinct user questions from prior sessions for the chip list. */
      questions: string[];
      /** Comprehension items the user previously engaged with — surfaced
       *  in the GapsPanel as "pick up where you left off." Each carries
       *  the prior level + commits-since-last-touch so the user knows
       *  if anything's drifted. */
      items?: Array<{
        itemId: string;
        label: string;
        layer: string;
        level: 'unknown'|'mentioned'|'heard'|'engaged'|'explained'|'confirmed';
        commitsSinceLastTouch: number;
      }>;
    } }
  | {
      type: 'quiz:question';
      payload: {
        questionId: string;
        question: string;
        index: number;
        total: number;
      };
    }
  | {
      type: 'ticket:created';
      payload: {
        provider: string;
        url: string;
        externalId: string;
        title: string;
      };
    }
  | {
      type: 'quiz:result';
      payload: {
        briefingId: string;
        correct: number;
        total: number;
        previousLevel: 'unknown'|'mentioned'|'heard'|'engaged'|'explained'|'confirmed';
        newLevel: 'unknown'|'mentioned'|'heard'|'engaged'|'explained'|'confirmed';
      };
    }
  | {
      /** Streamed chunk of an AI answer. Frontend appends chunks to its
       *  audio queue and plays them sequentially as each TTS clip is ready,
       *  so early sentences play while later sentences are still being
       *  TTS-generated — cuts perceived latency for long answers. */
      type: 'narration:stream_chunk';
      payload: {
        streamId: string;
        seq: number;
        text: string;
        isFinal: boolean;
        /** For code-layer streams: the line range (1-indexed,
         *  inclusive) the chunk is walking through. Frontend
         *  CodePanel highlights this range while the chunk plays. */
        range?: [number, number];
        /** For code-layer streams: the file the range applies to,
         *  used when the panel needs to scroll into view. */
        filePath?: string;
        /** Diagram node labels referenced in this chunk's text — drives
         *  the karaoke-ball visual: as the chunk's TTS plays, the
         *  frontend pulses the matching nodes so the user's eye
         *  follows the AI's words across the architecture map. */
        referencedNodes?: string[];
      };
    }
  | { type: 'session:heatmap'; payload: { heatmap: HeatmapData } }
  | { type: 'narration:segment_ready'; payload: { segment: NarrationSegment } }
  | { type: 'narration:text'; payload: { segmentId: string; text: string } }
  | { type: 'visual:highlight_file'; payload: { filePath: string; lines?: [number, number] } }
  | { type: 'visual:show_diff'; payload: { commitHash: string; filePath: string; hunks: Array<{ oldStart: number; newStart: number; content: string }> } }
  | { type: 'visual:show_code'; payload: { filePath: string; code: string; language: string; highlightLines?: number[] } }
  | { type: 'visual:diagram_focus'; payload: { nodeId: string; zoom?: number } }
  | { type: 'visual:diagram_update'; payload: { nodes: DiagramNode[]; edges: DiagramEdge[] } }
  | { type: 'visual:layer_change'; payload: { layer: VisualLayer; targetNodeId?: string; filePath?: string } }
  | { type: 'advisory:concern'; payload: { concern: Concern } }
  | { type: 'advisory:alert'; payload: { concern: Concern } }
  | { type: 'qa:answer_chunk'; payload: { text: string; done: boolean } }
  | { type: 'qa:answer_code'; payload: { filePath: string; snippet: string; language: string } }
  | { type: 'export:generating'; payload: { format: string; progress: number } }
  | { type: 'export:ready'; payload: { format: string; downloadUrl: string } }
  | { type: 'narration:greeting'; payload: { text: string } }
  | { type: 'session:understanding'; payload: { understanding: UnderstandingState } }
  | { type: 'skill:result'; payload: { result: SkillResult } }
  // Single visual sink: every answered turn drives the diagram through one
  // of these (focus pulse, drill, ascend, lateral cut). refs are resolved
  // node ids for halo/pulse; emitted even with zero refs (IN_PLACE,
  // reason 'no-refs') so the diagram is never static after an answer.
  | { type: 'visual:dispatch'; payload: { transition: VisualTransition; targetNodeId?: string; refs: string[]; reason: string; suggestion?: string } }
  // Fenced code lifted OUT of a spoken answer: rendered as a copyable card
  // on the canvas, never read aloud. Distinct from visual:show_code, which
  // is file-centric (filePath + highlight lines for the code-layer briefing
  // flow) — an artifact is generated content with no backing file.
  | { type: 'visual:artifact'; payload: { id: string; kind: 'commands' | 'code'; title?: string; language?: string; body: string } }
  | { type: 'skill:clarify'; payload: { message: string; options: string[] } }
  | { type: 'session:proposal'; payload: { message: string; suggestedOrder: string[]; areas: Array<{ id: string; name: string; significance: string }>; /** true ⇒ backend narrates via the open stream; the client must NOT speak `message` */ narrated?: boolean } }
  | { type: 'session:tour_progress'; payload: { total: number; covered: number; percentage: number } }
  | { type: 'action:issue_created'; payload: { url: string; number: number } }
  | { type: 'action:issue_failed'; payload: { error: string } }
  | { type: 'session:onboarding_day'; payload: { day: OnboardingDay; programName: string; totalDays: number } }
  | { type: 'session:onboarding_complete'; payload: { programId: string; completedDays: number; totalDays: number } }
  | { type: 'error'; payload: { code: string; message: string; recoverable: boolean } };

// Session state types
export type SessionPhase =
  | 'IDLE'
  | 'ANALYZING'
  | 'PROPOSAL'
  | 'PREVIOUSLY_ON'
  | 'HEATMAP'
  | 'OVERVIEW'
  | 'AREA_WALKTHROUGH'
  | 'AREA_TRANSITION'
  | 'PROJECT_OVERVIEW'
  | 'ARCHITECTURE_OVERVIEW'
  | 'COMPONENT_TOUR'
  | 'QA'
  | 'ADVISORY'
  | 'WRAP_UP'
  | 'EXPORTING'
  | 'COMPLETED'
  | 'ERROR';

export interface SessionState {
  phase: SessionPhase;
  areaIndex?: number;
  segmentIndex?: number;
  deepDive?: boolean;
  paused?: boolean;
  condensed?: boolean;
  prediction?: 'awaiting' | 'revealed';
  returnToPhase?: SessionPhase;
  returnToAreaIndex?: number;
  returnToSegmentIndex?: number;
  exportFormat?: 'slides' | 'markdown';
  error?: string;
  visualLayer?: VisualLayer;
}

export interface StateContext {
  sessionId: string;
  totalAreas: number;
  currentAreaSegments?: number;
  modes: SessionModes;
  concerns: Concern[];
}
