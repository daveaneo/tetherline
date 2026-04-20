# Voice tests

These exercise the parts of Tetherline that text-injection bypasses:
**mic capture, STT accuracy, interrupt latency, barge-in, TTS playback**.

They require real audio hardware (or a virtual device) and a running Whisper +
Kokoro stack. They are **not** in `pnpm test` or CI by default.

## Running

```bash
# 1. Start the voice server (TTS + STT) — leave running in a second terminal
.venv/bin/python packages/backend/src/tts/audio-server.py --preload

# 2. Create a virtual audio device (Linux / PulseAudio):
pactl load-module module-null-sink sink_name=tetherline_test sink_properties=device.description=TetherlineTest
pactl load-module module-remap-source master=tetherline_test.monitor source_name=tetherline_test_mic source_properties=device.description=TetherlineTestMic

# 3. Run the suite:
pnpm vitest run test/voice --config vitest.config.ts
```

## Suites

- `interrupt-latency.test.ts` — AI begins speaking; a pre-recorded "stop" WAV
  is pumped into the virtual mic; assert TTS goes silent within 300ms and
  `voiceState` transitions to `hearing` → `processing`.
- `barge-in.test.ts` — overlapping user audio + TTS, validate the barge-in
  heuristic triggers.
- `mic-start-gesture.test.ts` — browser permission gating via Playwright, using
  `--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream`.
- `stt-accuracy.test.ts` — WAVs of canonical commands ("next", "skip", "what
  is this") piped through the STT endpoint, assert transcript matches an
  accepted alias set (ASR tolerance baked in).
- `tts-playback.test.ts` — segment boundaries, buffer underruns, silence
  padding between segments.

## Fixtures

Pre-recorded WAVs live in `test/voice/audio/`. Keep them short (< 3s) and
encoded as 16kHz mono PCM to match the Whisper pipeline input.

## Why not in CI?

The default suite must stay hardware-free and fast (< 10s). Voice tests are
run by the maintainer on a Linux box before shipping changes to the audio
pipeline.
