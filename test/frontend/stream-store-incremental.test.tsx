/**
 * Incremental stream handling in the session store: with token streaming the
 * chunk queue regularly drains to EMPTY mid-stream (the orchestrator consumes
 * faster than the backend emits). These tests pin the two fixes:
 *  1. new-stream detection keys on currentStreamId, not queue emptiness —
 *     a same-stream chunk arriving after a full drain must APPEND, not reset;
 *  2. the final transcript/snapshot assembles from every RECEIVED chunk,
 *     including ones already consumed for playback.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../../packages/frontend/src/state/session-store.js';
import { useAudioStore } from '../../packages/frontend/src/state/audio-store.js';
import type { ServerEvent } from '@tetherline/shared';

function chunk(streamId: string, seq: number, text: string, opts?: { isFinal?: boolean; referencedNodes?: string[] }): ServerEvent {
  return {
    type: 'narration:stream_chunk',
    payload: {
      streamId,
      seq,
      text,
      isFinal: opts?.isFinal ?? false,
      referencedNodes: opts?.referencedNodes ?? [],
    },
  } as ServerEvent;
}

beforeEach(() => {
  useSessionStore.getState().resetSession();
});

describe('session-store incremental stream handling', () => {
  it('appends same-stream chunks after the queue drained to empty', () => {
    const s = () => useSessionStore.getState();
    s().handleServerEvent(chunk('qa-1', 0, 'First sentence.'));
    // Orchestrator consumes it — queue is now empty mid-stream.
    expect(s().consumeStreamChunk()?.text).toBe('First sentence.');
    expect(s().streamChunks).toHaveLength(0);

    s().handleServerEvent(chunk('qa-1', 1, 'Second sentence.'));
    // Same stream → append (NOT a reset that would wipe streamingFinal state).
    expect(s().streamChunks).toHaveLength(1);
    expect(s().currentStreamId).toBe('qa-1');
    expect(s().streamTranscript.map(c => c.text)).toEqual(['First sentence.', 'Second sentence.']);
  });

  it('a different streamId replaces the queue and restarts the transcript', () => {
    const s = () => useSessionStore.getState();
    s().handleServerEvent(chunk('qa-1', 0, 'Old answer start.'));
    s().handleServerEvent(chunk('qa-2', 0, 'New answer.'));
    expect(s().streamChunks).toHaveLength(1);
    expect(s().streamChunks[0].text).toBe('New answer.');
    expect(s().streamTranscript.map(c => c.text)).toEqual(['New answer.']);
    expect(s().currentStreamId).toBe('qa-2');
  });

  it('assembles the final transcript from consumed AND queued chunks', () => {
    const s = () => useSessionStore.getState();
    s().handleServerEvent(chunk('qa-1', 0, 'Alpha.', { referencedNodes: ['core'] }));
    s().consumeStreamChunk();
    s().handleServerEvent(chunk('qa-1', 1, 'Beta.'));
    s().consumeStreamChunk();
    s().handleServerEvent(chunk('qa-1', 2, 'Gamma.', { isFinal: true, referencedNodes: ['loader'] }));

    const history = s().conversationHistory;
    expect(history[history.length - 1].text).toBe('Alpha. Beta. Gamma.');

    const snap = s().turnSnapshots[s().turnSnapshots.length - 1];
    expect(snap.answer).toBe('Alpha. Beta. Gamma.');
    expect(new Set(snap.referencedNodes)).toEqual(new Set(['core', 'loader']));
    expect(s().touchedNodes.has('core')).toBe(true);
    expect(s().touchedNodes.has('loader')).toBe(true);
  });

  it('flips voiceState processing→listening on the first chunk (the ack)', () => {
    useAudioStore.getState().setVoiceState('processing');
    useSessionStore.getState().handleServerEvent(chunk('qa-1', 0, 'Let me take a look.'));
    expect(useAudioStore.getState().voiceState).toBe('listening');
  });
});
