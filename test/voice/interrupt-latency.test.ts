/**
 * Scaffold for the interrupt-latency voice test.
 *
 * Runs only when VOICE_TESTS=1 is set (hardware assumptions). See
 * `test/voice/README.md` for the required setup.
 */
import { describe, it, expect } from 'vitest';

const enabled = process.env.VOICE_TESTS === '1';
const maybe = enabled ? describe : describe.skip;

maybe('interrupt latency', () => {
  it('TTS goes silent within 300ms when user begins speaking', async () => {
    // TODO: implement using Playwright + a virtual PulseAudio sink.
    // 1. Launch the app, start a session, wait for narration to begin.
    // 2. Pump a pre-recorded "stop" WAV into the virtual mic.
    // 3. Assert window.__tetherline_diag.ttsPlaying === false within 300ms.
    expect(enabled).toBe(true);
  });
});
