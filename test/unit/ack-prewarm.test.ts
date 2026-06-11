/**
 * TTS prewarm: every FIXED spoken phrase (acks, steering hook, artifact lines,
 * flow bridge) must be synthesized into the disk cache at startup so it plays
 * with no synth latency — and re-warming must hit the cache, not re-synthesize.
 * Tested with a STUB provider + temp-dir cache: zero paid API calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AudioCache } from '../../packages/backend/src/tts/audio-cache.js';
import { warmPhrasesIntoCache, FIXED_SPOKEN_PHRASES } from '../../packages/backend/src/tts/ack-prewarm.js';
import { ALL_ACK_PHRASES, DEPTH_ACKS } from '../../packages/backend/src/session/ack-phrases.js';
import { STEERING_HOOK, FLOW_BRIDGE_LINE, ARTIFACT_REPLACEMENT_LINES } from '../../packages/backend/src/session/answer-streamer.js';

/** A TTSProvider stub: records calls, returns a tiny fake audio buffer. */
function stubProvider() {
  const calls: string[] = [];
  return {
    calls,
    provider: { generateSpeech: async (text: string) => { calls.push(text); return Buffer.from(`audio:${text}`); } },
  };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-warm-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const VOICE = 'kokoro';

describe('warmPhrasesIntoCache', () => {
  it('warms every fixed phrase, then short-circuits on a second run (no re-synth)', async () => {
    const cache = new AudioCache(dir);
    const s = stubProvider();

    const n1 = await warmPhrasesIntoCache(cache, s.provider, FIXED_SPOKEN_PHRASES, VOICE);
    expect(n1).toBe(FIXED_SPOKEN_PHRASES.length);
    for (const phrase of FIXED_SPOKEN_PHRASES) {
      expect(cache.has(phrase, VOICE), `cached: "${phrase}"`).toBe(true);
    }

    s.calls.length = 0;
    const n2 = await warmPhrasesIntoCache(cache, s.provider, FIXED_SPOKEN_PHRASES, VOICE);
    expect(n2, 'nothing re-synthesized on the warm run').toBe(0);
    expect(s.calls, 'provider never called when all cached').toEqual([]);
  });

  it('the fixed-phrase set covers acks, depth, steering hook, artifact lines, and the flow bridge', () => {
    for (const p of [...ALL_ACK_PHRASES, ...DEPTH_ACKS, STEERING_HOOK, ...ARTIFACT_REPLACEMENT_LINES, FLOW_BRIDGE_LINE]) {
      expect(FIXED_SPOKEN_PHRASES).toContain(p);
    }
  });

  it('a provider failure on one phrase does not abort the rest', async () => {
    const cache = new AudioCache(dir);
    const provider = {
      generateSpeech: async (text: string) => {
        if (text === FIXED_SPOKEN_PHRASES[0]) throw new Error('synth 500');
        return Buffer.from(text);
      },
    };
    await warmPhrasesIntoCache(cache, provider, FIXED_SPOKEN_PHRASES, VOICE);
    expect(cache.has(FIXED_SPOKEN_PHRASES[0], VOICE), 'failed phrase skipped').toBe(false);
    expect(cache.has(FIXED_SPOKEN_PHRASES[1], VOICE), 'rest still warmed').toBe(true);
  });
});
