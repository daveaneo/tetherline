import { config } from 'dotenv';
import { resolve } from 'path';

// Load .env from project root (not CWD which may be packages/backend)
config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '../../.env') });
import { createServer } from './server.js';
import { DEFAULT_PORT } from '@tetherline/shared';

export { createServer } from './server.js';

const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const repoPath = process.env.REPO_PATH ?? process.cwd();

async function main() {
  const { app, wss, server, db, digestScheduler } = await createServer({ port, repoPath });

  server.listen(port, () => {
    console.log(`Tetherline running at http://localhost:${port}`);
    console.log(`Analyzing repo: ${repoPath}`);
    digestScheduler.start();
    void probeAudioSidecar();
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    digestScheduler.stop();
    wss.close();
    db.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// One-shot probe so the operator knows whether voice (Whisper + Kokoro)
// will work this session. Web Speech fallback covers Chrome/Edge — but
// the silent-mic class of bugs always traces back to this. Retries for
// ~15s because `pnpm dev` starts the sidecar in parallel and Whisper +
// Kokoro model loading takes a few seconds on cold start.
async function probeAudioSidecar() {
  const url = process.env.AUDIO_SERVER_URL ?? 'http://127.0.0.1:3848';
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) {
        const body = (await r.json()) as { tts?: boolean; stt?: boolean };
        console.log(`[audio] sidecar ok at ${url} (stt=${!!body.stt} tts=${!!body.tts})`);
        return;
      }
    } catch {
      // not up yet — retry
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn(
    `[audio] sidecar unreachable at ${url} after 15s — STT/TTS will fall ` +
    `back to browser Web Speech (Chrome/Edge only). Run: pnpm dev:audio`
  );
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
