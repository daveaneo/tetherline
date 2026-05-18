/** Deterministic scene registry (H1).
 *
 * Each scene seeds the real zustand stores + a fixture diagram payload
 * so the REAL Room renders a specific skill's visual state with NO
 * backend, NO WebSocket, NO voice pipeline — instantly and identically
 * every run. This is what makes screenshot pixel-diff stable and lets
 * Claude verify/polish the UI fully autonomously.
 *
 * DEV-only: only reachable via `?scene=<name>` and gated on
 * import.meta.env.DEV in SceneHost. `sceneDiagramPayload` is never set
 * in production.
 */
import { useSessionStore } from '../state/session-store.js';
import { useShelfStore } from '../state/shelf-store.js';
import type { DiagramPayload } from '../components/room/diagram-types.js';
import type { ShelfArtifact } from '@tetherline/shared';

function basePayload(): DiagramPayload {
  return {
    scope: 'project',
    view: 'logic',
    title: 'Tetherline',
    subtitle: 'Stay tethered to your codebase',
    nodes: [
      { id: 'project', label: 'Tetherline', description: 'AI-narrated weekly code review', role: 'source', weight: 1, level: 'engaged', briefingId: 'project' },
      { id: 'module/core', label: 'Core', description: 'Git analysis, AI guide, TTS pipeline', role: 'transform', weight: 0.9, level: 'explained', briefingId: 'module/core' },
      { id: 'module/frontend', label: 'Frontend', description: 'React room: voice, diagram, shelf', role: 'transform', weight: 0.85, level: 'heard', briefingId: 'module/frontend' },
      { id: 'module/shared', label: 'Shared', description: 'Types + constants across packages', role: 'guard', weight: 0.5, level: 'mentioned', briefingId: 'module/shared' },
      { id: 'module/voice', label: 'Voice', description: 'Barge-in gate, narration streaming', role: 'sink', weight: 0.7, level: 'unknown', briefingId: 'module/voice' },
    ],
    edges: [
      { from: 'project', to: 'module/core', kind: 'contains' },
      { from: 'project', to: 'module/frontend', kind: 'contains' },
      { from: 'project', to: 'module/shared', kind: 'contains' },
      { from: 'project', to: 'module/voice', kind: 'contains' },
      { from: 'module/frontend', to: 'module/shared', kind: 'imports' },
      { from: 'module/core', to: 'module/voice', kind: 'imports' },
    ],
  };
}

function seedBase(payload: DiagramPayload = basePayload()) {
  useSessionStore.setState({
    state: { phase: 'OVERVIEW' },
    activeRepoPath: '/scene/tetherline',
    sceneDiagramPayload: payload,
    skillResult: null,
    conversationHistory: [],
  });
  useShelfStore.setState({
    open: false,
    artifacts: { notes: [], 'deep-dives': [], tasks: [], issues: [], comprehension: [] },
    unread: { notes: 0, 'deep-dives': 0, tasks: 0, issues: 0, comprehension: 0 },
  });
}

const art = (over: Partial<ShelfArtifact> & { id: string; section: ShelfArtifact['section']; summary: string }): ShelfArtifact => ({
  createdAt: '2026-05-16T00:00:00.000Z',
  ...over,
});

export interface Scene {
  name: string;
  description: string;
  seed: () => void;
}

export const SCENES: Scene[] = [
  {
    name: 'project-map',
    description: 'Baseline radial project map (no skill active)',
    seed: () => seedBase(),
  },
  {
    name: 'heatmap',
    description: 'whats_changed — DRIFT field: warm = changed code you haven\'t caught up on (no card)',
    seed: () => {
      seedBase();
      useSessionStore.setState({
        skillResult: {
          skillName: 'whats_changed', type: 'explanation',
          narration: "Core moved a lot and you haven't reviewed it. Voice shifted since you last looked. You're current on Shared.",
          visualPayload: {},
        } as never,
        // Real git-heatmap shape. DRIFT, not churn: red = changed &
        // never reviewed (HOT), yellow = changed since you reviewed
        // (WARM), green = changed but you're caught up (COLD), absent
        // = never moved (COLD).
        heatmap: {
          repoPath: '/scene/tetherline',
          generatedAt: '2026-05-18T00:00:00.000Z',
          entries: [
            { filePath: 'core/analyzer.ts', status: 'red', changeIntensity: 12, linesChanged: 120, familiarityScore: 0.2 },
            { filePath: 'core/chunker.ts', status: 'red', changeIntensity: 6, linesChanged: 60, familiarityScore: 0.1 },
            { filePath: 'voice/gate.ts', status: 'yellow', changeIntensity: 6, linesChanged: 60, familiarityScore: 0.5 },
            // Shared changed a lot but you've kept up → no heat.
            { filePath: 'shared/types.ts', status: 'green', changeIntensity: 9, linesChanged: 90, familiarityScore: 0.9 },
          ],
        },
      });
    },
  },
  {
    name: 'concern-tint',
    description: 'critique tint — nodes named in the spoken critique glow worry-red',
    seed: () => {
      seedBase();
      useSessionStore.setState({
        skillResult: {
          skillName: 'critique', type: 'explanation',
          narration: 'The Voice gate worries me — Core leans on it heavily and it has no test.',
          visualPayload: {},
        } as never,
      });
    },
  },
  {
    name: 'grill-screen',
    description: 'grill_me — the calm animated ? quiz screen replaces the diagram',
    seed: () => {
      seedBase();
      useSessionStore.setState({
        skillResult: {
          skillName: 'grill_me', type: 'explanation', narration: '',
          visualPayload: { topic: 'the voice barge-in gate' },
        } as never,
      });
    },
  },
  {
    name: 'shelf-notes',
    description: 'Review shelf open on the Notebook section with annotations',
    seed: () => {
      seedBase();
      useShelfStore.setState({
        open: true,
        activeSection: 'notes',
        artifacts: {
          notes: [
            art({ id: 'n1', section: 'notes', summary: 'Voice gate has no unit test — risky', detail: 'module/voice · Voice' }),
            art({ id: 'n2', section: 'notes', summary: 'Revisit the chunker anchor regex', detail: 'module/core' }),
          ],
          'deep-dives': [], tasks: [], issues: [], comprehension: [],
        },
        unread: { notes: 2, 'deep-dives': 0, tasks: 0, issues: 0, comprehension: 0 },
      });
    },
  },
  {
    name: 'shelf-tasks',
    description: 'Review shelf open on Tasks — running / done / blocked rows',
    seed: () => {
      seedBase();
      useShelfStore.setState({
        open: true,
        activeSection: 'tasks',
        artifacts: {
          notes: [], 'deep-dives': [], issues: [], comprehension: [],
          tasks: [
            art({ id: 't1', section: 'tasks', summary: 'Audit error handling across core', detail: 'Found 3 unguarded awaits', state: 'done' }),
            art({ id: 't2', section: 'tasks', summary: 'Refactor the chunker', detail: 'diff --git a/...', state: 'branch:task/chunker' }),
            art({ id: 't3', section: 'tasks', summary: 'Blocked: needed write (ceiling read_only)', detail: 'Raise the ceiling in Settings', state: 'blocked' }),
          ],
        },
        unread: { notes: 0, 'deep-dives': 0, tasks: 3, issues: 0, comprehension: 0 },
      });
    },
  },
  {
    name: 'descend',
    description: 'Drilled (DESCEND) into Core — scoped sub-graph',
    seed: () => {
      seedBase({
        scope: 'module/core', view: 'logic', title: 'Core', subtitle: 'Git analysis · AI guide · TTS',
        nodes: [
          { id: 'module/core', label: 'Core', description: 'The module', role: 'source', weight: 1, level: 'explained' },
          { id: 'file/core/analyzer', label: 'analyzer.ts', description: 'LLM Q&A + skills', role: 'transform', weight: 0.8, level: 'heard' },
          { id: 'file/core/diagram', label: 'diagram-extractor.ts', description: 'Conceptual pipeline', role: 'transform', weight: 0.7, level: 'mentioned' },
          { id: 'file/core/tts', label: 'audio-server.py', description: 'Whisper + Kokoro sidecar', role: 'sink', weight: 0.6, level: 'unknown' },
        ],
        edges: [
          { from: 'module/core', to: 'file/core/analyzer', kind: 'contains' },
          { from: 'module/core', to: 'file/core/diagram', kind: 'contains' },
          { from: 'module/core', to: 'file/core/tts', kind: 'contains' },
          { from: 'file/core/analyzer', to: 'file/core/tts', kind: 'produces' },
        ],
      });
    },
  },
  {
    name: 'deep-dive',
    description: 'deep_dive pocket — full-bleed slide presentation replaces the diagram',
    seed: () => {
      seedBase({
        scope: 'module/core', view: 'logic', title: 'Core', subtitle: 'Git analysis · AI guide · TTS',
        nodes: [
          { id: 'module/core', label: 'Core', description: 'The module', role: 'source', weight: 1, level: 'explained' },
          { id: 'file/core/analyzer', label: 'analyzer.ts', description: 'LLM Q&A + skills', role: 'transform', weight: 0.8, level: 'heard' },
        ],
        edges: [{ from: 'module/core', to: 'file/core/analyzer', kind: 'contains' }],
      });
      useSessionStore.setState({
        breadcrumbPocket: {
          focus: 'token refresh',
          slide: 2,
          total: 5,
          slides: [
            { title: 'Why token refresh exists', body: 'Access tokens are short-lived; the refresh path trades a long-lived refresh token for a new pair without forcing re-login.' },
            { title: 'Where it lives', body: 'analyzer.ts owns the call; the voice gate pauses narration while the round-trip is in flight so nothing talks over a stall.' },
            { title: 'The race we hit', body: 'Two concurrent 401s both triggered a refresh — the second clobbered the first new token. A single-flight lock now coalesces them.' },
            { title: 'Failure handling', body: 'A refresh that returns 401 means the session is truly dead: clear state, surface a calm "signed out" instead of a retry storm.' },
            { title: 'What to watch', body: 'Refresh latency feeds the barge-in budget. If p95 climbs, the gate holds the mic longer — track it as a first-class signal.' },
          ],
        },
      });
    },
  },
  {
    name: 'pipeline',
    description: 'Pipeline walkthrough — flow revealed source→sink, later stages dimmed',
    seed: () => {
      seedBase();
      useSessionStore.setState({ pipelineReveal: { step: 3 } });
    },
  },
  {
    name: 'blast-radius',
    description: 'Blast-radius ripple — impact rings fade outward from the changed file',
    seed: () => {
      seedBase({
        scope: 'module/core', view: 'logic', title: 'Core', subtitle: 'Blast radius of analyzer.ts',
        nodes: [
          { id: 'module/core', label: 'Core', description: 'The module', role: 'source', weight: 1, level: 'explained' },
          { id: 'file/core/analyzer', label: 'analyzer.ts', description: 'LLM Q&A + skills (changed)', role: 'transform', weight: 0.9, level: 'heard' },
          { id: 'file/core/chunker', label: 'chunker.ts', description: 'Narration chunking', role: 'transform', weight: 0.7, level: 'mentioned' },
          { id: 'file/core/diagram', label: 'diagram-extractor.ts', description: 'Conceptual pipeline', role: 'transform', weight: 0.7, level: 'mentioned' },
          { id: 'file/core/tts', label: 'audio-server.py', description: 'Whisper + Kokoro', role: 'sink', weight: 0.6, level: 'unknown' },
          { id: 'file/core/types', label: 'types.ts', description: 'Shared core types', role: 'guard', weight: 0.5, level: 'unknown' },
        ],
        edges: [
          { from: 'module/core', to: 'file/core/analyzer', kind: 'contains' },
          { from: 'module/core', to: 'file/core/chunker', kind: 'contains' },
          { from: 'module/core', to: 'file/core/diagram', kind: 'contains' },
          { from: 'module/core', to: 'file/core/tts', kind: 'contains' },
          { from: 'module/core', to: 'file/core/types', kind: 'contains' },
          { from: 'file/core/chunker', to: 'file/core/analyzer', kind: 'imports' },
          { from: 'file/core/diagram', to: 'file/core/analyzer', kind: 'imports' },
          { from: 'file/core/tts', to: 'file/core/chunker', kind: 'imports' },
          { from: 'file/core/types', to: 'file/core/diagram', kind: 'imports' },
        ],
      });
      useSessionStore.setState({ blastRadius: { changedId: 'file/core/analyzer' } });
    },
  },
  {
    name: 'guided-mode',
    description: 'Guided-learning tour — top-down spine, covered ▸ current ▸ upcoming',
    seed: () => {
      seedBase();
      // Shape mirrors TourPlan.fromArchitecture(Tetherline) output:
      // project root → one architecture step per module. Two steps
      // covered, walking the third.
      useSessionStore.setState({
        guidedTour: {
          currentIndex: 2,
          items: [
            { name: 'Tetherline', type: 'project', covered: true },
            { name: 'Core', type: 'architecture', covered: true },
            { name: 'Frontend', type: 'architecture', covered: false },
            { name: 'Shared', type: 'architecture', covered: false },
            { name: 'Voice', type: 'architecture', covered: false },
          ],
        },
      });
    },
  },
  {
    name: 'breadcrumb',
    description: 'You-are-here position trail inside a deep_dive pocket',
    seed: () => {
      seedBase({
        scope: 'module/core', view: 'logic', title: 'Core', subtitle: 'Git analysis · AI guide · TTS',
        nodes: [
          { id: 'module/core', label: 'Core', description: 'The module', role: 'source', weight: 1, level: 'explained' },
          { id: 'file/core/analyzer', label: 'analyzer.ts', description: 'LLM Q&A + skills', role: 'transform', weight: 0.8, level: 'heard' },
        ],
        edges: [{ from: 'module/core', to: 'file/core/analyzer', kind: 'contains' }],
      });
      useSessionStore.setState({
        breadcrumbPocket: { focus: 'token refresh', slide: 2, total: 8 },
      });
    },
  },
  {
    name: 'knowledge-layer',
    description: 'v3 title block (Seen deep + best Quiz/Grill for this view) + component Seen/Quiz summary bars',
    seed: () => {
      seedBase({
        scope: 'project', view: 'logic', title: 'Tetherline', subtitle: 'Knowledge v3 — Seen + Quiz/Grill',
        nodes: [
          // Overview watched (seen) but never quizzed at the overview level.
          { id: 'project', label: 'Tetherline', description: 'AI-narrated weekly code review', role: 'source', weight: 1, level: 'heard', seen: true, briefingId: 'project' },
          // Core: seen + perfect quiz + grill-passed.
          { id: 'module/core', label: 'Core', description: 'Git analysis, AI guide, TTS', role: 'transform', weight: 0.9, level: 'heard', seen: true, quizCorrect: 3, quizTotal: 3, grillStrong: 4, grillAsked: 5, grilled: true, briefingId: 'module/core' },
          // Frontend: seen + a regular quiz, no grill.
          { id: 'module/frontend', label: 'Frontend', description: 'React room: voice, diagram, shelf', role: 'transform', weight: 0.8, level: 'heard', seen: true, quizCorrect: 2, quizTotal: 3, briefingId: 'module/frontend' },
          // Shared: seen only — never tested.
          { id: 'module/shared', label: 'Shared', description: 'Types + constants across packages', role: 'guard', weight: 0.5, level: 'heard', seen: true, briefingId: 'module/shared' },
          // Voice: never surfaced (never seen).
          { id: 'module/voice', label: 'Voice', description: 'Barge-in gate, narration streaming', role: 'sink', weight: 0.7, level: 'unknown', seen: false, briefingId: 'module/voice' },
        ],
        edges: [
          { from: 'project', to: 'module/core', kind: 'contains' },
          { from: 'project', to: 'module/frontend', kind: 'contains' },
          { from: 'project', to: 'module/shared', kind: 'contains' },
          { from: 'project', to: 'module/voice', kind: 'contains' },
        ],
      });
    },
  },
  {
    name: 'knowledge-components',
    description: 'v3 drilled into Core — leaf files show their own Seen + Quiz/Grill summaries',
    seed: () => {
      seedBase({
        scope: 'module/core', view: 'logic', title: 'Core', subtitle: 'Leaf files — Seen + Quiz/Grill',
        nodes: [
          { id: 'module/core', label: 'Core', description: 'The module', role: 'source', weight: 1, level: 'heard', seen: true, quizCorrect: 2, quizTotal: 3, briefingId: 'module/core' },
          { id: 'file/core/analyzer', label: 'analyzer.ts', description: 'LLM Q&A + skills', role: 'transform', weight: 0.8, level: 'heard', seen: true, grillStrong: 5, grillAsked: 5, grilled: true },
          { id: 'file/core/chunker', label: 'chunker.ts', description: 'Narration chunking', role: 'transform', weight: 0.7, level: 'heard', seen: true, quizCorrect: 1, quizTotal: 3 },
          { id: 'file/core/tts', label: 'audio-server.py', description: 'Whisper + Kokoro', role: 'sink', weight: 0.6, level: 'unknown', seen: false },
        ],
        edges: [
          { from: 'module/core', to: 'file/core/analyzer', kind: 'contains' },
          { from: 'module/core', to: 'file/core/chunker', kind: 'contains' },
          { from: 'module/core', to: 'file/core/tts', kind: 'contains' },
        ],
      });
    },
  },
  {
    name: 'weak-spots-review',
    description: 'v3 weak-spots review panel expanded on the current layer',
    seed: () => {
      getScene('knowledge-layer')?.seed();
      useSessionStore.setState({
        weakSpots: [
          { itemId: 'project', question: 'How does the diagram cache stay fresh vs comprehension?', source: 'grill' },
          { itemId: 'project', question: 'What sets the grilled QA proof?', source: 'quiz' },
        ],
        sceneForceWeakSpotsOpen: true,
      });
    },
  },
];

export function getScene(name: string): Scene | undefined {
  return SCENES.find(s => s.name === name);
}
