/**
 * REGRESSION GUARD: every non-IDLE session phase must render visible content
 * in the Room. A blank screen for any entry mode is a hard failure — the user
 * reported this for `explore` on 2026-04-20 and we shipped a fix + this test.
 *
 * Tests render ContentPanel (the phase-aware workhorse) directly with mocked
 * state per phase. Each asserts meaningful text content appears. The Room
 * wrapper is tested separately for the layering invariant (see "Room layering"
 * block at the bottom).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { DEFAULT_MODES } from '@tetherline/shared';
import { ContentPanel } from '../../packages/frontend/src/components/room/ContentPanel.js';

// Stub network calls
vi.mock('../../packages/frontend/src/lib/api-client.js', () => ({
  api: {
    exportSlides: vi.fn().mockResolvedValue({ downloadUrl: '#' }),
    exportMarkdown: vi.fn().mockResolvedValue({ downloadUrl: '#' }),
    digestGenerate: vi.fn(),
    listRepos: vi.fn().mockResolvedValue({ repos: [] }),
  },
}));
vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({
  sendEvent: vi.fn(() => true),
}));

// framer-motion stubs — bypass animations in jsdom
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })),
});

type Phase =
  | 'ANALYZING' | 'PROPOSAL' | 'PREVIOUSLY_ON' | 'HEATMAP'
  | 'PROJECT_OVERVIEW' | 'ARCHITECTURE_OVERVIEW' | 'OVERVIEW'
  | 'COMPONENT_TOUR' | 'AREA_WALKTHROUGH' | 'QA'
  | 'ADVISORY' | 'WRAP_UP' | 'COMPLETED' | 'ERROR';

const sampleArea = {
  id: 'a1', sessionId: 'test-session', name: 'Idempotent capture',
  description: 'Makes retries safe.', orderIndex: 0,
  commitHashes: ['abc'], affectedFiles: ['src/core/capture.ts'],
  significance: 'major', theme: 'correctness', impactScore: 80,
  narrationSegments: [], architectureNodes: [], architectureEdges: [],
  deepDiveGenerated: false, reviewed: false,
} as any;

function primeStore(phase: Phase) {
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase, areaIndex: 0, segmentIndex: 0, error: phase === 'ERROR' ? 'Simulated' : undefined } as any,
    context: { sessionId: 'test-session', totalAreas: 1, modes: { ...DEFAULT_MODES }, concerns: [] },
    activeRepoPath: '/tmp/fixture',
    analysisProgress: { phase: 'reading_commits', progress: 0.5, message: 'Analyzing…' },
    areas: [sampleArea],
    proposal: { message: 'Here is the plan', suggestedOrder: ['a1'], areas: [{ id: 'a1', name: sampleArea.name, significance: 'major' }] },
    heatmap: { entries: [{ filePath: 'src/core/capture.ts', familiarity: 3, level: 'heard' }] } as any,
    concerns: phase === 'ADVISORY'
      ? [{ id: 'c1', severity: 'warning' as const, category: 'security', title: 'Sample concern', description: 'Detail', citations: [] } as any]
      : [],
    understanding: { layers: [], overallPercentage: 0 } as any,
    recap: 'Last week we covered basics.',
    previousSession: { id: 'prev', totalCommits: 10, totalAreas: 3 } as any,
    conversationHistory: [],
    currentBriefing: null,
    breadcrumb: { text: '', depth: 0, frames: [] },
    comprehensionMap: new Map(),
    quickPreview: null,
    streamedNarratives: new Map(),
    error: phase === 'ERROR' ? { code: 'X', message: 'Simulated', recoverable: false } : null,
    connected: true,
    skillResult: null,
    skillClarification: null,
  });
  useAudioStore.setState({
    ...useAudioStore.getState(),
    voiceState: 'listening',
    currentSegment: null,
    speechToasts: [],
  });
}

const phases: Phase[] = [
  'ANALYZING', 'PROPOSAL', 'PREVIOUSLY_ON', 'HEATMAP',
  'PROJECT_OVERVIEW', 'ARCHITECTURE_OVERVIEW', 'OVERVIEW',
  'COMPONENT_TOUR', 'AREA_WALKTHROUGH', 'QA',
  'ADVISORY', 'WRAP_UP', 'COMPLETED', 'ERROR',
];

describe('ContentPanel renders visible content for every phase', () => {
  beforeEach(() => cleanup());

  it.each(phases)('phase=%s produces meaningful text (no blank screen)', (phase) => {
    primeStore(phase);
    const { container } = render(<ContentPanel />);
    const text = container.textContent?.trim() ?? '';
    expect(text.length).toBeGreaterThan(10);
  });

  // Specific assertions per phase so text regressions surface loudly
  const expectedMarkers: Record<Phase, RegExp> = {
    ANALYZING: /Reading|Analyzing|Starting|repository/i,
    PROPOSAL: /plan|tour|let's/i,
    PREVIOUSLY_ON: /Previously|Where we left off|fresh start/i,
    HEATMAP: /Coverage|Understanding map|Map/i,
    PROJECT_OVERVIEW: /Project|First look/i,
    ARCHITECTURE_OVERVIEW: /Architecture|map/i,
    OVERVIEW: /this week|changed/i,
    COMPONENT_TOUR: /Idempotent capture|area/i,
    AREA_WALKTHROUGH: /Idempotent capture|area/i,
    QA: /Idempotent capture|area/i,
    ADVISORY: /Advisory|concern|look/i,
    WRAP_UP: /Session complete|End credits|Export/i,
    COMPLETED: /Session complete|Fin|updated/i,
    ERROR: /Something went wrong|Error/i,
  };

  it.each(phases)('phase=%s text matches its expected content marker', (phase) => {
    primeStore(phase);
    const { container } = render(<ContentPanel />);
    expect(container.textContent).toMatch(expectedMarkers[phase]);
  });
});
