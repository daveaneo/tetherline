/**
 * Voice status legibility: while the backend is classifying + generating
 * (1.5–12s after the user stops), the status must read "I heard you, working"
 * — not "paused" or "listening", which read as stalled/ignored.
 *
 * Live bug 2026-06-10: "as you were processing it said like paused… there
 * should be a clear visual that you've heard me and output is coming."
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import { NarrationBar } from '../../packages/frontend/src/components/room/NarrationBar.js';

vi.mock('../../packages/frontend/src/lib/ws-client.js', () => ({ sendEvent: vi.fn() }));
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
});

function seed(voiceState: any, opts: { floorPhase?: any; paused?: boolean } = {}) {
  useAudioStore.setState({ ...useAudioStore.getState(), voiceState, floorPhase: opts.floorPhase ?? 'open' });
  useSessionStore.setState({
    ...useSessionStore.getState(),
    state: { phase: 'OVERVIEW', areaIndex: 0, segmentIndex: 0, paused: opts.paused ?? false } as any,
    areas: [],
  } as any);
}

const label = () => screen.getByTestId('voice-status-label').textContent ?? '';
const orbState = () => screen.getByTestId('voice-orb').getAttribute('data-state');

beforeEach(() => { cleanup(); });
afterEach(() => { cleanup(); });

describe('NarrationBar voice status', () => {
  it('processing → "thinking" treatment, never "paused"', () => {
    seed('processing');
    render(<NarrationBar />);
    expect(label()).toMatch(/on it|thinking/i);
    expect(label()).not.toMatch(/paused/i);
    expect(orbState()).toBe('processing');
  });

  it('awaiting-response (between utterance ship and first chunk) still reads as thinking', () => {
    seed('listening', { floorPhase: 'awaiting-response' });
    render(<NarrationBar />);
    expect(label()).toMatch(/on it|thinking/i);
    expect(orbState()).toBe('processing');
  });

  it('idle with mic off says "mic off", not "paused"', () => {
    seed('idle', { paused: false });
    render(<NarrationBar />);
    expect(label()).toMatch(/mic off/i);
    expect(label()).not.toMatch(/paused/i);
  });

  it('a genuine session pause says "paused"', () => {
    seed('idle', { paused: true });
    render(<NarrationBar />);
    expect(label()).toMatch(/paused/i);
  });
});
