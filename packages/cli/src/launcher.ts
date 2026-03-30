import path from 'path';
import fs from 'fs';
import open from 'open';
import { createServer } from '@interactive-reviewer/backend';

interface LaunchOptions {
  repoPath: string;
  port: number;
  autoOpen: boolean;
  sinceDays: number;
}

export async function launch(options: LaunchOptions) {
  const repoPath = path.resolve(options.repoPath);

  // Validate repo
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    console.error(`Error: ${repoPath} is not a git repository`);
    process.exit(1);
  }

  console.log('Starting Interactive Reviewer...');
  console.log(`Repository: ${repoPath}`);
  console.log(`Looking back: ${options.sinceDays} days`);

  const { server, wss } = await createServer({
    port: options.port,
    repoPath,
  });

  server.listen(options.port, async () => {
    const url = `http://localhost:${options.port}`;
    console.log(`\nRunning at ${url}`);

    if (options.autoOpen) {
      await open(url);
    }
  });

  const shutdown = () => {
    console.log('\nShutting down...');
    wss.close();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
