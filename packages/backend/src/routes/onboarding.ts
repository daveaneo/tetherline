import { Router } from 'express';
import path from 'path';
import simpleGit from 'simple-git';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import type { VisualLayer } from '@tetherline/shared';

export function createOnboardingRoutes(db: Database, config: AppConfig): Router {
  const router = Router();

  // Generate a program for a repo
  router.post('/generate', async (req, res) => {
    const { repoPath } = req.body;
    if (!repoPath) { res.status(400).json({ error: 'repoPath required' }); return; }

    // Check if program already exists
    const existing = db.getOnboardingRepo().getProgramsForRepo(repoPath);
    if (existing.length > 0) {
      res.json({ program: existing[0], alreadyExists: true });
      return;
    }

    try {
      const git = simpleGit(repoPath);
      const fileTreeRaw = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD']).catch(() => '');
      const fileTree = fileTreeRaw.split('\n').filter(Boolean);
      const repoName = path.basename(repoPath);

      // Try AI generation
      const apiKey = config.anthropicApiKey;
      let days: any[];

      if (apiKey) {
        const { IntelligenceAnalyzer } = await import('../intelligence/analyzer.js');
        const { ClaudeClient } = await import('../intelligence/claude-client.js');
        const client = new ClaudeClient(apiKey);
        const analyzer = new IntelligenceAnalyzer(client, { repoName, languages: [], sinceDate: '', untilDate: '', commitCount: 0 });
        const { buildOnboardingPrompt, ONBOARDING_TOOL } = await import('../intelligence/prompts/onboarding.js');

        const prompt = buildOnboardingPrompt({ repoName, languages: [], fileTree, areaNames: [], totalFiles: fileTree.length });
        const result = await analyzer.structuredCallDirect<{ days: any[] }>({
          prompt,
          toolName: ONBOARDING_TOOL.name,
          toolDescription: ONBOARDING_TOOL.description,
          inputSchema: ONBOARDING_TOOL.inputSchema,
        });
        days = result.days;
      } else {
        // Fallback: generate a basic program
        days = [
          { dayNumber: 1, title: 'Project Overview', description: 'Learn what the project does and why.', topics: ['Purpose', 'Key concepts', 'Getting started'], estimatedMinutes: 15 },
          { dayNumber: 2, title: 'Architecture', description: 'Understand how the main pieces connect.', topics: ['Module structure', 'Data flow', 'Dependencies'], estimatedMinutes: 20 },
          { dayNumber: 3, title: 'Core Components', description: 'Deep dive into the most important modules.', topics: ['Main module', 'Business logic', 'Data layer'], estimatedMinutes: 25 },
          { dayNumber: 4, title: 'Supporting Systems', description: 'Explore secondary modules and utilities.', topics: ['Configuration', 'Utilities', 'Integration points'], estimatedMinutes: 20 },
          { dayNumber: 5, title: 'Code Patterns', description: 'Learn conventions and common patterns.', topics: ['Coding style', 'Error handling', 'Testing patterns'], estimatedMinutes: 15 },
        ];
      }

      const layerMap: Record<number, VisualLayer> = { 1: 1, 2: 2, 3: 4, 4: 4, 5: 5 };
      const program = db.getOnboardingRepo().createProgram({
        repoPath,
        name: `${repoName} Onboarding`,
        totalDays: days.length,
        days: days.map(d => ({
          ...d,
          targetLayer: layerMap[d.dayNumber] ?? 3,
          completed: false,
        })),
      });

      res.json({ program });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List programs for a repo
  router.get('/programs', (req, res) => {
    const repoPath = req.query.repoPath as string;
    if (!repoPath) { res.status(400).json({ error: 'repoPath query param required' }); return; }
    const programs = db.getOnboardingRepo().getProgramsForRepo(repoPath);
    res.json({ programs });
  });

  // Get program details
  router.get('/programs/:id', (req, res) => {
    const program = db.getOnboardingRepo().getProgram(req.params.id);
    if (!program) { res.status(404).json({ error: 'Not found' }); return; }
    const progress = db.getOnboardingRepo().getProgress(program.id);
    res.json({ program, progress });
  });

  // Start or get progress
  router.post('/programs/:id/start', (req, res) => {
    const program = db.getOnboardingRepo().getProgram(req.params.id);
    if (!program) { res.status(404).json({ error: 'Not found' }); return; }
    let progress = db.getOnboardingRepo().getProgress(program.id);
    if (!progress) {
      progress = db.getOnboardingRepo().startProgress(program.id);
    }
    res.json({ progress });
  });

  // Complete a day
  router.post('/programs/:id/complete-day', (req, res) => {
    const { dayNumber } = req.body;
    db.getOnboardingRepo().completeDay(req.params.id, dayNumber);
    const progress = db.getOnboardingRepo().getProgress(req.params.id);
    res.json({ progress });
  });

  return router;
}
