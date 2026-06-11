/**
 * Flow-aware quick chips: when an authored flow is on screen, the tap-to-ask
 * chips offer flow-specific questions ("What's inside <first stage>?",
 * "What feeds <last stage>?") so the user can probe containment by tap — the
 * live "are those inside these five?" need (2026-06-10).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { QuickChips } from '../../packages/frontend/src/components/room/QuickChips.js';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

function seedFlow() {
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: undefined, segmentIndex: 0, paused: false } as any,
    areas: [],
    skillResult: {
      skillName: 'visualize', type: 'diagram', narration: '',
      visualPayload: {
        target: 'core', kind: 'pipeline',
        diagram: {
          scope: 'flow/module/core', view: 'logic', title: 'Core Data Pipeline', subtitle: '',
          nodes: [
            { id: 'wc', label: 'WebCollector' },
            { id: 'dc', label: 'DataCleaner' },
            { id: 'pg', label: 'PairGenerator' },
          ],
          edges: [],
        },
      },
    } as any,
  } as any);
}

describe('QuickChips — flow-aware', () => {
  it('offers containment chips for the first and last stage of an authored flow', () => {
    seedFlow();
    render(<QuickChips />);
    expect(screen.getByText(/inside WebCollector/i)).toBeInTheDocument();
    expect(screen.getByText(/feeds.*PairGenerator/i)).toBeInTheDocument();
  });

  it('shows only phase chips when no flow is active', () => {
    useSessionStore.setState({
      ...useSessionStore.getState(),
      state: { phase: 'OVERVIEW', areaIndex: undefined, segmentIndex: 0, paused: false } as any,
      areas: [],
      skillResult: null,
    } as any);
    render(<QuickChips />);
    expect(screen.queryByText(/inside WebCollector/i)).not.toBeInTheDocument();
    expect(screen.getByText(/What is this project/i)).toBeInTheDocument();
  });
});
