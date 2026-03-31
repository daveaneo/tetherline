import { create } from 'zustand';
import type {
  SessionState, StateContext, ServerEvent, AreaWithContent,
  AnalysisProgress, Concern, HeatmapData, SessionSummary, UnderstandingState,
  SkillResult,
} from '@interactive-reviewer/shared';
import { DEFAULT_MODES } from '@interactive-reviewer/shared';

interface SessionStore {
  state: SessionState;
  context: StateContext;
  areas: AreaWithContent[];
  analysisProgress: AnalysisProgress | null;
  heatmap: HeatmapData | null;
  concerns: Concern[];
  previousSession: SessionSummary | null;
  recap: string | null;
  greeting: string | null;
  qaAnswer: string;
  qaAnswerDone: boolean;
  understanding: UnderstandingState | null;
  skillResult: SkillResult | null;
  skillClarification: { message: string; options: string[] } | null;
  tourProgress: { total: number; covered: number; percentage: number } | null;
  error: { code: string; message: string; recoverable: boolean } | null;
  connected: boolean;

  handleServerEvent: (event: ServerEvent) => void;
  clearError: () => void;
  setConnected: (v: boolean) => void;
  resetSession: () => void;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  state: { phase: 'IDLE' },
  context: { sessionId: '', totalAreas: 0, modes: { ...DEFAULT_MODES }, concerns: [] },
  areas: [],
  analysisProgress: null,
  heatmap: null,
  concerns: [],
  previousSession: null,
  recap: null,
  greeting: null,
  qaAnswer: '',
  qaAnswerDone: false,
  understanding: null,
  skillResult: null,
  skillClarification: null,
  tourProgress: null,
  error: null,
  connected: false,

  clearError: () => set({ error: null }),
  setConnected: (v: boolean) => set({ connected: v }),

  resetSession: () => set({
    state: { phase: 'IDLE' },
    context: { sessionId: '', totalAreas: 0, modes: { ...DEFAULT_MODES }, concerns: [] },
    areas: [],
    analysisProgress: null,
    heatmap: null,
    concerns: [],
    previousSession: null,
    recap: null,
    greeting: null,
    qaAnswer: '',
    qaAnswerDone: false,
    understanding: null,
    skillResult: null,
    skillClarification: null,
    tourProgress: null,
    error: null,
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

      case 'session:state_changed':
        set({ state: event.payload.state, context: event.payload.context });
        break;

      case 'session:recap':
        set({ previousSession: event.payload.previousSession, recap: event.payload.narrative });
        break;

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
        break;

      case 'narration:greeting':
        set({ greeting: event.payload.text });
        break;

      case 'session:understanding':
        set({ understanding: event.payload.understanding });
        break;

      case 'skill:result':
        set({ skillResult: event.payload.result, skillClarification: null });
        break;

      case 'skill:clarify':
        set({ skillClarification: event.payload });
        break;

      case 'session:tour_progress':
        set({ tourProgress: event.payload });
        break;

      case 'error':
        console.error('Server error:', event.payload);
        set({ error: event.payload });
        break;

      default:
        // Other events handled by specific components
        break;
    }
  },
}));
