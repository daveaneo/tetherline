import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import type { Concern } from '@interactive-reviewer/shared';
import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { generateRevealSlides } from '../export/reveal-generator.js';
import { generateMarkdownDigest } from '../export/markdown-generator.js';

function getExportsDir(config: AppConfig): string {
  const dir = path.join(config.dataDir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConcernsForSession(db: Database, sessionId: string): Concern[] {
  const rows = db.getRawDb().prepare(
    'SELECT * FROM concerns WHERE session_id = ? ORDER BY severity DESC',
  ).all(sessionId) as any[];

  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    areaId: row.area_id ?? undefined,
    severity: row.severity,
    category: row.category,
    title: row.title,
    description: row.description,
    affectedFiles: JSON.parse(row.affected_files || '[]'),
    commitHashes: JSON.parse(row.commit_hashes || '[]'),
    codeReferences: JSON.parse(row.code_references || '[]'),
    acknowledged: !!row.acknowledged,
  }));
}

export function createExportRoutes(db: Database, config: AppConfig): Router {
  const router = Router();

  router.post('/:sessionId/slides', (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = db.getSessionRepo().getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const areas = db.getAreaRepo().getAreasForSession(sessionId);
      const concerns = getConcernsForSession(db, sessionId);
      const html = generateRevealSlides(session, areas, concerns);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_');
      const filename = `review-${session.repoName}-${timestamp}.html`;
      const exportsDir = getExportsDir(config);
      fs.writeFileSync(path.join(exportsDir, filename), html, 'utf-8');

      res.json({
        format: 'slides',
        filename,
        downloadUrl: `/api/export/download/${filename}`,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Failed to generate slides' });
    }
  });

  router.post('/:sessionId/markdown', (req, res) => {
    try {
      const { sessionId } = req.params;
      const session = db.getSessionRepo().getSession(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const areas = db.getAreaRepo().getAreasForSession(sessionId);
      const concerns = getConcernsForSession(db, sessionId);
      const markdown = generateMarkdownDigest(session, areas, concerns);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_');
      const filename = `review-${session.repoName}-${timestamp}.md`;
      const exportsDir = getExportsDir(config);
      fs.writeFileSync(path.join(exportsDir, filename), markdown, 'utf-8');

      res.json({
        format: 'markdown',
        filename,
        downloadUrl: `/api/export/download/${filename}`,
        generatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'Failed to generate markdown' });
    }
  });

  router.get('/download/:filename', (req, res) => {
    const resolved = path.resolve(getExportsDir(config), req.params.filename);
    if (!resolved.startsWith(path.resolve(getExportsDir(config)))) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.download(resolved);
  });

  return router;
}
