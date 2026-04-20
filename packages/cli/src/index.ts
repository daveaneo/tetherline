#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { launch } from './launcher.js';

const program = new Command();

program
  .name('tetherline')
  .description('Stay tethered to your codebase — AI-narrated weekly code reviews')
  .version('0.1.0');

program
  .argument('[repo]', 'Path to git repository', '.')
  .option('-p, --port <number>', 'Port to run on', '3847')
  .option('--no-open', 'Do not open browser automatically')
  .option('--since <days>', 'Number of days to look back', '7')
  .action(async (repo: string, options: { port: string; open: boolean; since: string }) => {
    await launch({
      repoPath: repo,
      port: parseInt(options.port, 10),
      autoOpen: options.open,
      sinceDays: parseInt(options.since, 10),
    });
  });

program.parse();
