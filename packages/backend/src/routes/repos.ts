import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import simpleGit from 'simple-git';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';

const GIT_URL_REGEX = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/)/;

function isGitUrl(input: string): boolean {
  return GIT_URL_REGEX.test(input) || (input.includes('github.com') && input.includes('/'));
}

function repoNameFromUrl(url: string): string {
  // Extract repo name from URL: "https://github.com/user/repo.git" → "repo"
  const cleaned = url.replace(/\.git$/, '').replace(/\/$/, '');
  const parts = cleaned.split('/');
  return parts[parts.length - 1] || 'unknown';
}

export function createRepoRoutes(db: Database, config: AppConfig): Router {
  const router = Router();
  const cloneDir = path.join(config.dataDir, 'repos');
  fs.mkdirSync(cloneDir, { recursive: true });

  // List all repos
  router.get('/', (_req, res) => {
    const repos = db.getRepoRepo().getAll();

    const enriched = repos.map(repo => {
      const newCommits = 0;
      return { ...repo, newCommits };
    });

    res.json({ repos: enriched });
  });

  // Add a new repo (local path OR remote URL)
  router.post('/', async (req, res) => {
    const { path: repoInput } = req.body;
    if (!repoInput) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    let resolvedPath: string;
    let name: string;

    if (isGitUrl(repoInput)) {
      // Remote URL — clone it
      name = repoNameFromUrl(repoInput);
      resolvedPath = path.join(cloneDir, name);

      // Check if already cloned/added
      const existing = db.getRepoRepo().getByPath(resolvedPath);
      if (existing) {
        res.json({ repo: existing, alreadyExists: true });
        return;
      }

      // Clone the repo
      try {
        if (fs.existsSync(resolvedPath)) {
          // Directory exists but not in DB — might be a previous failed clone
          // Try to pull instead
          const git = simpleGit(resolvedPath);
          await git.pull();
        } else {
          const git = simpleGit();
          await git.clone(repoInput, resolvedPath);
        }
      } catch (err: any) {
        res.status(400).json({ error: `Failed to clone: ${err.message}` });
        return;
      }
    } else {
      // Local path
      resolvedPath = path.resolve(repoInput);
      name = path.basename(resolvedPath);

      if (!fs.existsSync(path.join(resolvedPath, '.git'))) {
        res.status(400).json({ error: 'Not a git repository. For remote repos, use the full URL (e.g. https://github.com/user/repo)' });
        return;
      }

      // Check if already added
      const existing = db.getRepoRepo().getByPath(resolvedPath);
      if (existing) {
        res.json({ repo: existing, alreadyExists: true });
        return;
      }
    }

    // Get repo info
    const git = simpleGit(resolvedPath);
    let commitCount = 0;
    let contributorCount = 0;
    try {
      const log = await git.log();
      commitCount = log.total;
      const authors = new Set(log.all.map(c => c.author_name));
      contributorCount = authors.size;
    } catch {
      // Ignore errors from git log
    }

    const repo = db.getRepoRepo().add(resolvedPath, name);
    res.json({ repo, commitCount, contributorCount });
  });

  // Get repo details with recent activity
  router.get('/:id', async (req, res) => {
    const repo = db.getRepoRepo().getById(req.params.id);
    if (!repo) {
      res.status(404).json({ error: 'Repository not found' });
      return;
    }

    let newCommits = 0;
    let contributors: string[] = [];
    try {
      const git = simpleGit(repo.path);
      const sinceDate = repo.lastReviewedAt ?? new Date(Date.now() - 30 * 86400000).toISOString();
      const log = await git.log({ '--since': sinceDate } as any);
      newCommits = log.total;
      contributors = [...new Set(log.all.map(c => c.author_name))];
    } catch {
      // Ignore errors from git log
    }

    // Get sessions for this repo
    const sessions = db.getSessionRepo().listSessions()
      .filter(s => s.repoName === repo.name)
      .slice(0, 5);

    res.json({ repo, newCommits, contributors, recentSessions: sessions });
  });

  /**
   * Read-only file content endpoint for the code-layer briefing UI.
   * Looks up the repo by path (frontend already knows activeRepoPath)
   * and serves the requested file if it lives inside a registered repo.
   *
   * Capped at 200KB. Path traversal is rejected.
   */
  router.get('/file', async (req, res) => {
    const fs = await import('fs');
    const path = await import('path');
    const repoPath = String(req.query.repoPath ?? '').trim();
    const rel = String(req.query.path ?? '').trim();
    if (!repoPath || !rel) {
      res.status(400).json({ error: 'repoPath + path query params required' });
      return;
    }
    const repo = db.getRepoRepo().getByPath(repoPath);
    if (!repo) { res.status(404).json({ error: 'repo not registered' }); return; }
    const resolved = path.resolve(repo.path, rel);
    if (!resolved.startsWith(path.resolve(repo.path) + path.sep)) {
      res.status(400).json({ error: 'path escapes repo' });
      return;
    }
    let stat: import('fs').Stats;
    try { stat = fs.statSync(resolved); }
    catch { res.status(404).json({ error: 'file not found' }); return; }
    if (!stat.isFile()) { res.status(400).json({ error: 'not a file' }); return; }
    if (stat.size > 200_000) { res.status(413).json({ error: 'file too large (>200KB)' }); return; }
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({ path: rel, content, sizeBytes: stat.size });
  });

  // Remove a repo
  router.delete('/:id', (req, res) => {
    db.getRepoRepo().remove(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
