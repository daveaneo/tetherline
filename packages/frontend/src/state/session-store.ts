import { create } from 'zustand';
import type {
  SessionState, StateContext, ServerEvent, AreaWithContent,
  AnalysisProgress, Concern, HeatmapData, SessionSummary, UnderstandingState,
  SkillResult, VisualLayer, ConceptualStep,
} from '@interactive-reviewer/shared';
import { DEFAULT_MODES } from '@interactive-reviewer/shared';

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
  skillClarification: { message: string; options: string[] } | null;
  visualLayer: VisualLayer;
  conceptualSteps: ConceptualStep[];
  tourProgress: { total: number; covered: number; percentage: number } | null;
  lastIssueResult: { url: string; number: number } | null;
  error: { code: string; message: string; recoverable: boolean } | null;
  connected: boolean;
  conversationHistory: ConversationEntry[];

  handleServerEvent: (event: ServerEvent) => void;
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
  skillClarification: null,
  visualLayer: 1 as VisualLayer,
  conceptualSteps: [],
  tourProgress: null,
  lastIssueResult: null,
  error: null,
  connected: false,
  conversationHistory: [],

  addConversation: (speaker, text) => set(s => ({
    conversationHistory: [...s.conversationHistory.slice(-49), { speaker, text, timestamp: Date.now() }],
  })),

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
    skillClarification: null,
    visualLayer: 1 as VisualLayer,
    conceptualSteps: [],
    tourProgress: null,
    lastIssueResult: null,
    error: null,
    conversationHistory: [],
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
        set({ greeting: event.payload.text });
        get().addConversation('ai', event.payload.text);
        break;

      case 'session:understanding':
        set({ understanding: event.payload.understanding });
        break;

      case 'skill:result':
        set({ skillResult: event.payload.result, skillClarification: null });
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

      default:
        // Other events handled by specific components
        break;
    }
  },
}));
