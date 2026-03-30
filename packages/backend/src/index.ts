import 'dotenv/config';
import { createServer } from './server.js';
import { DEFAULT_PORT } from '@interactive-reviewer/shared';

export { createServer } from './server.js';

const port = parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
const repoPath = process.env.REPO_PATH ?? process.cwd();

async function main() {
  const { app, wss, server, db } = await createServer({ port, repoPath });

  server.listen(port, () => {
    console.log(`Interactive Reviewer running at http://localhost:${port}`);
    console.log(`Analyzing repo: ${repoPath}`);
  });

  const shutdown = () => {
    console.log('\nShutting down...');
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
