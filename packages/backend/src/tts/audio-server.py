"""
Local audio server: Kokoro TTS + Whisper STT.
Runs as a sidecar process, called by the Node.js backend.

Usage: python audio-server.py [--port 3848] [--voice af_heart] [--whisper-model base.en]

Endpoints:
  POST /tts       { "text": "...", "voice": "af_heart" }  → audio/wav
  POST /transcribe  (audio/wav body)                       → { "text": "..." }
  GET  /health    → { "status": "ok", "tts": true, "stt": true }
  GET  /voices    → { "voices": [...] }
"""
import argparse
import io
import json
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

# Lazy-load models
_tts_pipeline = None
_whisper_model = None
_whisper_model_size = 'base.en'

# Import probe results — populated lazily on the first /health call (and
# every subsequent /health call) so the endpoint reports HONEST
# availability instead of an unconditional `True`. Caching the result
# avoids re-importing on every probe. `None` = not yet checked.
_tts_probe = None      # tuple[bool, str | None]
_stt_probe = None      # tuple[bool, str | None]


def probe_tts():
    """Try to import the TTS backend. Returns (ok, error_message)."""
    global _tts_probe
    if _tts_probe is not None:
        return _tts_probe
    try:
        import importlib
        importlib.import_module('kokoro')
        _tts_probe = (True, None)
    except Exception as e:
        _tts_probe = (False, f"{type(e).__name__}: {e}")
    return _tts_probe


def probe_stt():
    """Try to import the STT backend. Returns (ok, error_message)."""
    global _stt_probe
    if _stt_probe is not None:
        return _stt_probe
    try:
        import importlib
        importlib.import_module('faster_whisper')
        _stt_probe = (True, None)
    except Exception as e:
        _stt_probe = (False, f"{type(e).__name__}: {e}")
    return _stt_probe

AVAILABLE_VOICES = [
    'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
    'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx',
]


def get_tts_pipeline():
    global _tts_pipeline
    if _tts_pipeline is None:
        from kokoro import KPipeline
        _tts_pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
        print("[audio] TTS pipeline loaded", flush=True)
    return _tts_pipeline


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        print(f"[audio] Loading Whisper model ({_whisper_model_size})...", flush=True)
        _whisper_model = WhisperModel(_whisper_model_size, device="cpu", compute_type="int8")
        print("[audio] Whisper model loaded", flush=True)
    return _whisper_model


class AudioHandler(BaseHTTPRequestHandler):
    def send_json_error(self, status, message):
        """Return a small JSON error body instead of the stdlib's default
        HTML. The Node backend forwards `upstream` to the frontend toast
        verbatim; HTML there reads as garbage."""
        body = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == '/tts':
            self.handle_tts()
        elif self.path == '/transcribe':
            self.handle_transcribe()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == '/health':
            # Honest probe: tts/stt are TRUE only when the backing
            # libraries are importable. The previous unconditional
            # `True` lied to the Node backend, which lied to the
            # frontend — every transcription silently failed because
            # /health said STT worked when faster_whisper wasn't even
            # installed. Cached in _tts_probe / _stt_probe so this
            # endpoint stays cheap on repeat hits.
            tts_ok, tts_err = probe_tts()
            stt_ok, stt_err = probe_stt()
            body = {
                "status": "ok",
                "engine": "kokoro+whisper",
                "tts": tts_ok,
                "stt": stt_ok,
            }
            if not tts_ok:
                body["ttsError"] = tts_err
            if not stt_ok:
                body["sttError"] = stt_err
            response = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        elif self.path == '/voices':
            response = json.dumps({"voices": AVAILABLE_VOICES}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)
        else:
            self.send_error(404)

    def handle_tts(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_json_error(400, 'Invalid JSON')
            return

        text = data.get('text', '').strip()
        voice = data.get('voice', 'af_heart')

        if not text:
            self.send_json_error(400, 'text is required')
            return

        try:
            import numpy as np
            import soundfile as sf

            pipe = get_tts_pipeline()
            audio_segments = []
            for _, _, audio in pipe(text, voice=voice):
                audio_segments.append(audio)

            if not audio_segments:
                self.send_json_error(500, 'No audio generated')
                return

            full_audio = np.concatenate(audio_segments)
            buf = io.BytesIO()
            sf.write(buf, full_audio, 24000, format='WAV')
            wav_bytes = buf.getvalue()

            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)

        except Exception as e:
            print(f"[audio] TTS error: {e}", flush=True)
            self.send_json_error(500, str(e))

    def handle_transcribe(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            self.send_json_error(400, 'No audio data')
            return

        audio_data = self.rfile.read(content_length)

        try:
            import tempfile
            import os
            model = get_whisper_model()

            # Determine file extension from content type
            content_type = self.headers.get('Content-Type', 'audio/wav')
            ext = '.wav'
            if 'webm' in content_type:
                ext = '.webm'
            elif 'ogg' in content_type:
                ext = '.ogg'
            elif 'mp3' in content_type:
                ext = '.mp3'

            # Write to temp file — faster-whisper/ffmpeg needs file extension for format detection
            with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
                tmp.write(audio_data)
                tmp_path = tmp.name

            start = time.time()
            segments, info = model.transcribe(tmp_path, beam_size=1, language="en", vad_filter=True)

            text_parts = []
            for segment in segments:
                text_parts.append(segment.text.strip())

            text = ' '.join(text_parts).strip()
            elapsed = time.time() - start

            response = json.dumps({
                "text": text,
                "language": info.language,
                "duration": round(elapsed, 2),
            }).encode()

            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

            # Clean up temp file
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

        except Exception as e:
            print(f"[audio] Transcription error: {e}", flush=True)
            # Clean up temp file on error too
            try:
                os.unlink(tmp_path)
            except (OSError, NameError):
                pass
            self.send_json_error(500, str(e))

    def log_message(self, format, *args):
        pass


def main():
    global _whisper_model_size

    parser = argparse.ArgumentParser(description='Local Audio Server (TTS + STT)')
    parser.add_argument('--port', type=int, default=3848)
    parser.add_argument('--voice', type=str, default='af_heart')
    parser.add_argument('--whisper-model', type=str, default='base.en',
                        choices=['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large-v3'],
                        help='Whisper model size. Default base.en — sweet spot for English-only voice input '
                             '(~10% more accurate on long-form than tiny, ~1s extra latency on CPU). '
                             'Use tiny for fastest, small/medium for best accuracy.')
    parser.add_argument('--preload', action='store_true', help='Load models on startup')
    args = parser.parse_args()

    _whisper_model_size = args.whisper_model

    if args.preload:
        print("[audio] Preloading models...", flush=True)
        get_tts_pipeline()
        get_whisper_model()

    # Probe dependencies on startup (before HTTPServer.listen) so:
    #   1. The operator sees failures immediately, not via baffling
    #      "transcription failed" toasts later.
    #   2. The first /health hit is fast. Lazy probing imported
    #      kokoro + faster_whisper synchronously on first call,
    #      which loads torch (~5s). The Node backend's /health probe
    #      has a 2s timeout — so the FIRST /health from the frontend
    #      timed out, the frontend cached voiceMode='none', and PTT
    #      silently dropped utterances even though the sidecar was
    #      actually fine. Eager probe means /health is always sub-ms.
    print("[audio] Probing dependencies...", flush=True)
    tts_ok, tts_err = probe_tts()
    stt_ok, stt_err = probe_stt()

    server = HTTPServer(('127.0.0.1', args.port), AudioHandler)
    print(f"[audio] Server running on http://127.0.0.1:{args.port}", flush=True)
    if tts_ok:
        print(f"[audio] TTS: Kokoro (voice: {args.voice})", flush=True)
    else:
        print(f"[audio] TTS: UNAVAILABLE — {tts_err}", flush=True)
        print("[audio]      → install: pip install kokoro (use the repo .venv)", flush=True)
    if stt_ok:
        print(f"[audio] STT: Whisper ({args.whisper_model})", flush=True)
    else:
        print(f"[audio] STT: UNAVAILABLE — {stt_err}", flush=True)
        print("[audio]      → install: pip install faster-whisper (use the repo .venv)", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[audio] Shutting down", flush=True)
        server.server_close()


if __name__ == '__main__':
    main()
