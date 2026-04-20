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

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
