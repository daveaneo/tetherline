/**
 * Code-layer briefings — generated on-demand from live file content,
 * NOT persisted in the briefings table.
 *
 * Why on-demand rather than pre-warmed: the file's content is the
 * source of truth, the regex-based symbol extraction is fast, and the
 * briefing is never reused across sessions (the user's cursor moves).
 * Pre-warming would just bloat the cache with rarely-used data.
 *
 * Output: a Briefing with layer='code'. The opener is a TTS-safe spoken
 * pitch that names the file + symbol + what it does at a glance. The
 * talkingPoints carry the actual code chunks the user can have walked
 * through line-by-line. The frontend code panel renders the file with
 * the active range highlighted.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { Briefing } from '@tetherline/shared';

export interface CodeBriefingRequest {
  repoPath: string;
  /** Repo-relative file path (e.g. "packages/backend/src/session/manager.ts"). */
  filePath: string;
  /** Optional symbol name to focus on. If omitted, the briefing covers
   *  the whole file with the first interesting symbol highlighted. */
  symbol?: string;
}

export interface CodeChunk {
  /** Spoken-form description for the chunk ("Here's the dispatcher…"). */
  voiceLine: string;
  /** Lines [start, end] inclusive, 1-indexed. The frontend highlights
   *  this range when the chunk is being spoken. */
  range: [number, number];
}

/** Compose a code-layer briefing. Returns null if the file isn't readable
 *  or doesn't contain anything worth narrating. */
export function composeCodeBriefing(req: CodeBriefingRequest): { briefing: Briefing; chunks: CodeChunk[] } | null {
  const fullPath = path.join(req.repoPath, req.filePath);
  let source: string;
  try {
    source = fs.readFileSync(fullPath, 'utf8');
  } catch { return null; }
  if (source.trim().length === 0) return null;

  const lines = source.split('\n');
  const symbols = extractSymbols(lines);
  const focused = req.symbol
    ? symbols.find(s => s.name === req.symbol)
      ?? symbols.find(s => s.name.toLowerCase() === req.symbol!.toLowerCase())
    : symbols[0];

  // Build the spoken opener — a one-line "what you're looking at" that's
  // calibrated to be TTS-safe.
  const filename = path.basename(req.filePath);
  let opener: string;
  if (focused) {
    opener = `Walking through ${focused.kind} ${focused.name} in ${filename}. ` +
      describeSymbolAtAGlance(focused, lines) +
      ' Tap into a section to hear it line by line, or step back up.';
  } else {
    opener = `Looking at ${filename}. ${lines.length} lines, ${symbols.length} top-level symbols. ` +
      'Pick one or step back up.';
  }

  // Chunks the user can have walked through. Each chunk is a meaningful
  // span — a function body, a class declaration, a notable constant.
  const chunks: CodeChunk[] = symbols.slice(0, 8).map(s => ({
    voiceLine: `${capitalize(s.kind)} ${s.name} — ${describeSymbolAtAGlance(s, lines)}`,
    range: [s.startLine, s.endLine],
  }));

  const id = req.symbol
    ? `code/${req.filePath}:${req.symbol}`
    : `code/${req.filePath}`;
  // Source hash includes the file's content so the briefing is naturally
  // invalidated when the code changes — drives drift detection later.
  const sourceHash = createHash('sha256')
    .update(req.filePath + '\u0001' + source).digest('hex').slice(0, 16);

  const fileBriefingId = `file/${req.filePath}`;
  return {
    briefing: {
      id,
      repoPath: req.repoPath,
      layer: 'code',
      title: req.symbol ? `${req.symbol} (${filename})` : filename,
      opener,
      talkingPoints: chunks.map(c => c.voiceLine),
      children: [], // code is the leaf — no further drilling.
      parent: fileBriefingId,
      visualCue: { kind: 'code_panel', ref: req.filePath },
      estimatedSeconds: Math.max(15, Math.min(45, Math.ceil(opener.split(/\s+/).length / 2.5))),
      sourceHash,
      cachedAt: new Date().toISOString(),
    },
    chunks,
  };
}

interface ExtractedSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'constant' | 'interface' | 'type' | 'export';
  startLine: number;
  endLine: number;
}

/** Lightweight symbol extractor — regex-based, language-agnostic enough
 *  for TS/JS/Python/Go/Rust to surface useful names. Doesn't need to be
 *  perfect; just good enough to give the user navigation handles. */
function extractSymbols(lines: string[]): ExtractedSymbol[] {
  const out: ExtractedSymbol[] = [];
  const patterns: Array<{ re: RegExp; kind: ExtractedSymbol['kind'] }> = [
    { re: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=/, kind: 'type' },
    { re: /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*[=:]/, kind: 'constant' },
    { re: /^\s*(?:public\s+|private\s+)?(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*[:{]/, kind: 'method' },
    { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: 'function' }, // Python
    { re: /^\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)/, kind: 'function' }, // Go
    { re: /^\s*pub\s+fn\s+([A-Za-z_]\w*)/, kind: 'function' }, // Rust
  ];

  for (let i = 0; i < lines.length; i++) {
    for (const { re, kind } of patterns) {
      const m = lines[i].match(re);
      if (m && m[1]) {
        // End line: walk forward looking for matching brace closure /
        // dedent. Approximation: at most 80 lines past the start.
        const endLine = findSymbolEnd(lines, i);
        out.push({ name: m[1], kind, startLine: i + 1, endLine });
        break;
      }
    }
  }
  return out;
}

function findSymbolEnd(lines: string[], startIdx: number): number {
  // Brace-counting heuristic for TS/JS/Go/Rust/Java-like syntax.
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length && i < startIdx + 200; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; started = true; }
      else if (ch === '}') { depth -= 1; if (started && depth <= 0) return i + 1; }
    }
  }
  // Indent-based fallback (Python).
  const indent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
  for (let i = startIdx + 1; i < lines.length && i < startIdx + 200; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const cur = line.match(/^\s*/)?.[0].length ?? 0;
    if (cur <= indent) return i;
  }
  return Math.min(lines.length, startIdx + 30);
}

function describeSymbolAtAGlance(s: ExtractedSymbol, lines: string[]): string {
  // Pull the first comment block / signature line for a brief gloss.
  const sigLine = lines[s.startLine - 1]?.trim() ?? '';
  // Look upward for a JSDoc / line-comment cluster.
  const commentLines: string[] = [];
  for (let i = s.startLine - 2; i >= Math.max(0, s.startLine - 10); i--) {
    const line = lines[i]?.trim() ?? '';
    if (/^\/\/\s|^\*\s|^\/\*\*?|^\#\s|^\*\//.test(line)) {
      commentLines.unshift(line.replace(/^[\/\*\s#]+/, '').replace(/\*+\/?\s*$/, '').trim());
    } else if (line === '') {
      continue;
    } else { break; }
  }
  const comment = commentLines.filter(Boolean).join(' ').slice(0, 200);
  if (comment) return comment;
  // No comment — fall back to a short signature gloss.
  return `Defined at line ${s.startLine}: ${sigLine.slice(0, 100)}`;
}

function capitalize(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
