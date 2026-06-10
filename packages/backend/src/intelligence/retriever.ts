/**
 * Deterministic grounding retrieval — pulls REAL file contents into the
 * answer prompt so the model stops improvising from stale summaries.
 * Synchronous on purpose (fs + better-sqlite3 are both sync): ≤7 bounded
 * reads land in well under 200ms, which keeps the path compatible with
 * token streaming (no spoken buffer needed).
 *
 * Ranked pipeline: README+manifest anchors always → explicit classifier
 * target → current file → keyword-scored file index → top module's key
 * files. Budgeted at 5 files / ~4k tokens. Never writes to any cache;
 * always reads the live working tree, so content can't be stale.
 */
import fs from 'fs';
import path from 'path';
import type { ContextCacheRepository, FileCacheRow } from '../db/repositories/context-cache-repo.js';
import { extractKeywords } from '../cache/context-composer.js';
import { resolveCodeTarget } from './code-target.js';

export interface RetrievalRequest {
  question: string;
  /** Classifier-extracted params (target/file/component/topic/concept…). */
  params?: Record<string, string>;
  currentFile?: string;
  tokenBudget?: number;   // default 4000
  maxFiles?: number;      // default 5 (anchors not counted against it)
}

export type RetrievalReason = 'anchor' | 'explicit-target' | 'current-file' | 'keyword' | 'module-key-file';

export interface RetrievedFile {
  filePath: string;        // repo-relative
  content: string;         // truncated live read
  truncated: boolean;
  reason: RetrievalReason;
  score: number;
}

export interface RetrievalResult {
  files: RetrievedFile[];
  tokensUsed: number;
  /** 'target-hit' — explicit target resolved; 'matched' — ≥1 scored file;
   *  'anchors-only' — nothing beyond README/manifest (drives the
   *  "don't see it… want me to dig?" offer). */
  confidence: 'target-hit' | 'matched' | 'anchors-only';
  /** Ready-to-prepend "## Repository files (ground truth)" block. */
  promptBlock: string;
}

const README_TOKEN_CAP = 2000;
const MANIFEST_TOKEN_CAP = 600;
const PER_FILE_TOKEN_CAP = 1500;
const MAX_FILE_BYTES = 200 * 1024;
const MANIFESTS = ['package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'go.mod'];

/** Param keys whose values name a code target worth resolving to a file. */
const TARGET_KEYS = ['target', 'file', 'component', 'module', 'symbol'];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, 1024);
  return probe.includes(0);
}

export class Retriever {
  constructor(
    private cacheRepo: ContextCacheRepository,
    private repoPath: string,
  ) {}

  retrieve(req: RetrievalRequest): RetrievalResult {
    const tokenBudget = req.tokenBudget ?? 4000;
    const maxFiles = req.maxFiles ?? 5;
    const files: RetrievedFile[] = [];
    const seen = new Set<string>();
    let tokensUsed = 0;

    const add = (filePath: string, reason: RetrievalReason, score: number, opts?: { tokenCap?: number; symbol?: string }) => {
      if (seen.has(filePath)) return false;
      if (reason !== 'anchor' && files.filter(f => f.reason !== 'anchor').length >= maxFiles) return false;
      if (tokensUsed >= tokenBudget) return false;
      const read = this.readFile(filePath, opts?.tokenCap ?? PER_FILE_TOKEN_CAP, opts?.symbol);
      if (!read) return false;
      const cost = estimateTokens(read.content);
      if (tokensUsed + cost > tokenBudget && files.length > 0) return false;
      seen.add(filePath);
      files.push({ filePath, content: read.content, truncated: read.truncated, reason, score });
      tokensUsed += cost;
      return true;
    };

    // 1. Anchors: README + manifest, always. This alone grounds "how do I
    // install / run / set up" — the class of question that hallucinated.
    const readme = this.findCaseInsensitive('README.md') ?? this.findCaseInsensitive('readme.md');
    if (readme) add(readme, 'anchor', 100, { tokenCap: README_TOKEN_CAP });
    for (const m of MANIFESTS) {
      if (fs.existsSync(path.join(this.repoPath, m))) {
        add(m, 'anchor', 90, { tokenCap: MANIFEST_TOKEN_CAP });
        break;
      }
    }

    // 2. Explicit target from the classifier.
    let targetHit = false;
    for (const key of TARGET_KEYS) {
      const target = req.params?.[key]?.trim();
      if (!target) continue;
      const resolved = resolveCodeTarget(this.repoPath, target, this.cacheRepo);
      if (resolved && add(resolved.filePath, 'explicit-target', 80, { symbol: resolved.symbol })) {
        targetHit = true;
      }
    }

    // 3. Current file when the question is deictic ("this", "here").
    if (req.currentFile && /\b(this|here|current)\b/i.test(req.question)) {
      add(req.currentFile, 'current-file', 70);
    }

    // 4. Keyword scoring over the existing file index.
    const keywords = extractKeywords(req.question);
    const indexed = this.cacheRepo.getFilesForRepo(this.repoPath);
    const roleBoost = this.roleBoostFor(req.question);
    const scored = indexed
      .map(f => ({ f, score: this.scoreFile(f, keywords, roleBoost) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score || (b.f.connectivity ?? 0) - (a.f.connectivity ?? 0));
    for (const { f, score } of scored) {
      if (!add(f.filePath, 'keyword', score)) break;
    }

    // 5. Top-module key files round out the budget.
    const modules = this.cacheRepo.getModulesForRepo(this.repoPath);
    const topModule = modules
      .map(m => ({
        m,
        score: keywords.reduce((s, k) =>
          s + (m.summary.toLowerCase().includes(k) ? 1 : 0) + (m.modulePath.toLowerCase().includes(k) ? 2 : 0), 0),
      }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)[0];
    if (topModule) {
      for (const kf of topModule.m.keyFiles) {
        if (!add(kf, 'module-key-file', topModule.score)) break;
      }
    }

    const confidence: RetrievalResult['confidence'] = targetHit
      ? 'target-hit'
      : files.some(f => f.reason !== 'anchor') ? 'matched' : 'anchors-only';

    return { files, tokensUsed, confidence, promptBlock: buildPromptBlock(files) };
  }

  private findCaseInsensitive(name: string): string | null {
    const direct = path.join(this.repoPath, name);
    if (fs.existsSync(direct)) return name;
    try {
      const entries = fs.readdirSync(this.repoPath);
      const hit = entries.find(e => e.toLowerCase() === name.toLowerCase());
      return hit ?? null;
    } catch {
      return null;
    }
  }

  private roleBoostFor(question: string): Record<string, number> {
    const q = question.toLowerCase();
    const boost: Record<string, number> = {};
    if (/\b(install|setup|set up|run|start|config|deploy|build)\b/.test(q)) boost['config'] = 2;
    if (/\btest(s|ing)?\b/.test(q)) boost['test'] = 2;
    if (/\b(api|endpoint|route|request)\b/.test(q)) boost['route'] = 2;
    if (/\b(model|schema|table|migration)\b/.test(q)) boost['model'] = 2;
    if (/\b(entry|main|boot|start)\b/.test(q)) boost['entry'] = 2;
    return boost;
  }

  private scoreFile(f: FileCacheRow, keywords: string[], roleBoost: Record<string, number>): number {
    if (keywords.length === 0) return 0;
    const base = path.basename(f.filePath).toLowerCase();
    const stem = base.replace(/\.[^.]+$/, '');
    const pathLower = f.filePath.toLowerCase();
    const summaryLower = (f.summary ?? '').toLowerCase();
    let score = 0;
    for (const k of keywords) {
      if (stem === k) score += 5;
      else if (pathLower.split(/[/._-]/).includes(k)) score += 3;
      if (summaryLower.includes(k)) score += 1;
    }
    score += roleBoost[f.role] ?? 0;
    return score;
  }

  private readFile(relPath: string, tokenCap: number, symbol?: string): { content: string; truncated: boolean } | null {
    const full = path.join(this.repoPath, relPath);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
      const buf = fs.readFileSync(full);
      if (looksBinary(buf)) return null;
      let text = buf.toString('utf8');
      // Symbol slice: a window around the matched symbol beats the file head.
      if (symbol) {
        const idx = text.search(new RegExp(`(?:function|class|interface|type|const|def|func|fn)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
        if (idx > 0) {
          const start = Math.max(0, text.lastIndexOf('\n', Math.max(0, idx - 400)));
          text = text.slice(start);
        }
      }
      const charCap = tokenCap * 4;
      if (text.length > charCap) {
        return { content: text.slice(0, charCap), truncated: true };
      }
      return { content: text, truncated: false };
    } catch {
      return null;
    }
  }
}

function buildPromptBlock(files: RetrievedFile[]): string {
  if (files.length === 0) {
    return (
      '## Repository files (ground truth)\n' +
      'No repository files could be read for this question. Answer only from the ' +
      'summaries above; if the information is not there, say plainly that you ' +
      "don't see it in the repo. Never invent file names, commands, dependencies, or setup steps."
    );
  }
  const header =
    '## Repository files (ground truth)\n' +
    'Below are the ACTUAL contents of files from this repo (some truncated). ' +
    'Base every factual claim about this repo on these files and the summaries above. ' +
    'If the user asks about something that is not in these files or summaries, say ' +
    "plainly that you don't see it in the repo — for example, \"I don't see any " +
    'installation steps in the repo." Never invent file names, commands, dependencies, ' +
    "or setup steps. If a file is marked truncated and might contain the answer, say " +
    'you only see part of it. Cite naturally for speech: "in the readme", "in ' +
    'package.json" — no line numbers, no markdown.';
  const body = files.map(f =>
    `### ${f.filePath}${f.truncated ? ' (truncated)' : ''}\n\`\`\`\n${f.content}\n\`\`\``,
  ).join('\n\n');
  return `${header}\n\n${body}`;
}
