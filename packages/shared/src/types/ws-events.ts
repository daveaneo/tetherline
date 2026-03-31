import type { AnalysisProgress, Area, AreaWithContent, NarrationSegment, DiagramNode, DiagramEdge } from './analysis.js';
import type { Concern } from './concerns.js';
import type { HeatmapData } from './heatmap.js';
import type { SessionModes, ModeKey, EntryMode } from './modes.js';
import type { Session, SessionSummary } from './session.js';
import type { UnderstandingState } from './understanding.js';

// Client → Server
export type ClientEvent =
  | { type: 'session:start'; payload: { repoPath: string; sinceDays?: number; entryMode?: EntryMode } }
  | { type: 'session:resume'; payload: { sessionId: string } }
  | { type: 'command:next' }
  | { type: 'command:previous' }
  | { type: 'command:dive_deeper' }
  | { type: 'command:skip' }
  | { type: 'command:pause' }
  | { type: 'command:resume' }
  | { type: 'command:ask'; payload: { question: string } }
  | { type: 'command:toggle_mode'; payload: { mode: ModeKey; enabled: boolean } }
  | { type: 'command:export'; payload: { format: 'slides' | 'markdown' } }
  | { type: 'audio:segment_finished'; payload: { segmentId: string } };

// Server → Client
export type ServerEvent =
  | { type: 'analysis:started'; payload: { sessionId: string } }
  | { type: 'analysis:progress'; payload: AnalysisProgress }
  | { type: 'analysis:area_ready'; payload: { area: Area } }
  | { type: 'analysis:complete'; payload: { summary: SessionSummary; areas: AreaWithContent[] } }
  | { type: 'session:state_changed'; payload: { state: SessionState; context: StateContext } }
  | { type: 'session:recap'; payload: { previousSession: SessionSummary; narrative: string } }
  | { type: 'session:heatmap'; payload: { heatmap: HeatmapData } }
  | { type: 'narration:segment_ready'; payload: { segment: NarrationSegment } }
  | { type: 'narration:text'; payload: { segmentId: string; text: string } }
  | { type: 'visual:highlight_file'; payload: { filePath: string; lines?: [number, number] } }
  | { type: 'visual:show_diff'; payload: { commitHash: string; filePath: string; hunks: Array<{ oldStart: number; newStart: number; content: string }> } }
  | { type: 'visual:show_code'; payload: { filePath: string; code: string; language: string; highlightLines?: number[] } }
  | { type: 'visual:diagram_focus'; payload: { nodeId: string; zoom?: number } }
  | { type: 'visual:diagram_update'; payload: { nodes: DiagramNode[]; edges: DiagramEdge[] } }
  | { type: 'advisory:concern'; payload: { concern: Concern } }
  | { type: 'advisory:alert'; payload: { concern: Concern } }
  | { type: 'qa:answer_chunk'; payload: { text: string; done: boolean } }
  | { type: 'qa:answer_code'; payload: { filePath: string; snippet: string; language: string } }
  | { type: 'export:generating'; payload: { format: string; progress: number } }
  | { type: 'export:ready'; payload: { format: string; downloadUrl: string } }
  | { type: 'narration:greeting'; payload: { text: string } }
  | { type: 'session:understanding'; payload: { understanding: UnderstandingState } }
  | { type: 'error'; payload: { code: string; message: string; recoverable: boolean } };

// Session state types
export type SessionPhase =
  | 'IDLE'
  | 'ANALYZING'
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
  prediction?: 'awaiting' | 'revealed';
  returnToPhase?: SessionPhase;
  returnToAreaIndex?: number;
  returnToSegmentIndex?: number;
  exportFormat?: 'slides' | 'markdown';
  error?: string;
}

export interface StateContext {
  sessionId: string;
  totalAreas: number;
  currentAreaSegments?: number;
  modes: SessionModes;
  concerns: Concern[];
}
