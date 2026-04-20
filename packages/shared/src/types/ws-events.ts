import type { AnalysisProgress, Area, AreaWithContent, NarrationSegment, DiagramNode, DiagramEdge } from './analysis.js';
import type { Concern } from './concerns.js';
import type { HeatmapData } from './heatmap.js';
import type { SessionModes, ModeKey, EntryMode } from './modes.js';
import type { Session, SessionSummary } from './session.js';
import type { UnderstandingState } from './understanding.js';
import type { SkillResult } from './skills.js';
import type { VisualLayer } from './visual-layer.js';
import type { OnboardingDay } from './onboarding.js';

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
  | { type: 'audio:segment_finished'; payload: { segmentId: string } }
  | { type: 'user:utterance'; payload: { text: string; timestamp: number } }
  | { type: 'action:confirm_issue'; payload: { title: string; body: string; labels: string[] } }
  | { type: 'session:start_onboarding'; payload: { repoPath: string; programId?: string; dayNumber?: number } };

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
  | { type: 'skill:clarify'; payload: { message: string; options: string[] } }
  | { type: 'session:proposal'; payload: { message: string; suggestedOrder: string[]; areas: Array<{ id: string; name: string; significance: string }> } }
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
