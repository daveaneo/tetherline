"""
Local audio server: Kokoro TTS + Whisper STT.
Runs as a sidecar process, called by the Node.js backend.

Usage: python audio-server.py [--port 3848] [--voice af_heart] [--whisper-model tiny]

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
_whisper_model_size = 'tiny'

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
    def do_POST(self):
        if self.path == '/tts':
            self.handle_tts()
        elif self.path == '/transcribe':
            self.handle_transcribe()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == '/health':
            response = json.dumps({
                "status": "ok",
                "engine": "kokoro+whisper",
                "tts": True,
                "stt": True,
            }).encode()
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
            self.send_error(400, 'Invalid JSON')
            return

        text = data.get('text', '').strip()
        voice = data.get('voice', 'af_heart')

        if not text:
            self.send_error(400, 'text is required')
            return

        try:
            import numpy as np
            import soundfile as sf

            pipe = get_tts_pipeline()
            audio_segments = []
            for _, _, audio in pipe(text, voice=voice):
                audio_segments.append(audio)

            if not audio_segments:
                self.send_error(500, 'No audio generated')
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
            self.send_error(500, str(e))

    def handle_transcribe(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            self.send_error(400, 'No audio data')
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
            self.send_error(500, str(e))

    def log_message(self, format, *args):
        pass


def main():
    global _whisper_model_size

    parser = argparse.ArgumentParser(description='Local Audio Server (TTS + STT)')
    parser.add_argument('--port', type=int, default=3848)
    parser.add_argument('--voice', type=str, default='af_heart')
    parser.add_argument('--whisper-model', type=str, default='tiny',
                        choices=['tiny', 'base', 'small', 'medium', 'large-v3'],
                        help='Whisper model size (tiny=fastest, large-v3=best)')
    parser.add_argument('--preload', action='store_true', help='Load models on startup')
    args = parser.parse_args()

    _whisper_model_size = args.whisper_model

    if args.preload:
        print("[audio] Preloading models...", flush=True)
        get_tts_pipeline()
        get_whisper_model()

    server = HTTPServer(('127.0.0.1', args.port), AudioHandler)
    print(f"[audio] Server running on http://127.0.0.1:{args.port}", flush=True)
    print(f"[audio] TTS: Kokoro (voice: {args.voice})", flush=True)
    print(f"[audio] STT: Whisper ({args.whisper_model})", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[audio] Shutting down", flush=True)
        server.server_close()


if __name__ == '__main__':
    main()
