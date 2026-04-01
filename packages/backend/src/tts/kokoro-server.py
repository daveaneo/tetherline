"""
Lightweight HTTP server that wraps Kokoro TTS.
Runs as a sidecar process, called by the Node.js backend.

Usage: python kokoro-server.py [--port 3848] [--voice af_heart]

Endpoints:
  POST /tts  { "text": "...", "voice": "af_heart" }  → audio/wav
  GET  /health  → { "status": "ok" }
  GET  /voices  → { "voices": [...] }
"""
import argparse
import io
import json
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
import soundfile as sf

# Lazy-load the pipeline to avoid slow startup on health checks
_pipeline = None

AVAILABLE_VOICES = [
    'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore',
    'af_nicole', 'af_nova', 'af_river', 'af_sarah', 'af_sky',
    'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx',
]

def get_pipeline():
    global _pipeline
    if _pipeline is None:
        from kokoro import KPipeline
        _pipeline = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
        print("[kokoro] Pipeline loaded", flush=True)
    return _pipeline


class TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/tts':
            self.send_error(404)
            return

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
            pipe = get_pipeline()
            # Collect all audio segments
            audio_segments = []
            for _, _, audio in pipe(text, voice=voice):
                audio_segments.append(audio)

            if not audio_segments:
                self.send_error(500, 'No audio generated')
                return

            # Concatenate segments
            import numpy as np
            full_audio = np.concatenate(audio_segments)

            # Write to WAV buffer
            buf = io.BytesIO()
            sf.write(buf, full_audio, 24000, format='WAV')
            wav_bytes = buf.getvalue()

            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav')
            self.send_header('Content-Length', str(len(wav_bytes)))
            self.end_headers()
            self.wfile.write(wav_bytes)

        except Exception as e:
            print(f"[kokoro] Error: {e}", flush=True)
            self.send_error(500, str(e))

    def do_GET(self):
        if self.path == '/health':
            response = json.dumps({"status": "ok", "engine": "kokoro"}).encode()
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

    def log_message(self, format, *args):
        # Quieter logging
        pass


def main():
    parser = argparse.ArgumentParser(description='Kokoro TTS Server')
    parser.add_argument('--port', type=int, default=3848)
    parser.add_argument('--voice', type=str, default='af_heart')
    parser.add_argument('--preload', action='store_true', help='Load model on startup')
    args = parser.parse_args()

    if args.preload:
        print("[kokoro] Preloading model...", flush=True)
        get_pipeline()

    server = HTTPServer(('127.0.0.1', args.port), TTSHandler)
    print(f"[kokoro] TTS server running on http://127.0.0.1:{args.port}", flush=True)
    print(f"[kokoro] Default voice: {args.voice}", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[kokoro] Shutting down", flush=True)
        server.server_close()


if __name__ == '__main__':
    main()
