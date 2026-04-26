/**
 * Code observations — surface-level signals found while warming the
 * cache. These become `advisory:concern` events the user can browse
 * (NOT quizzes — Hermes never tests the user proactively).
 *
 * Currently detected:
 *   • TODO / FIXME clusters (>= 3 markers in one file)
 *   • Long files (> 500 lines)
 *   • Modules without tests (no peer test/ dir or *.test.* files)
 *
 * Cheap by design: one filesystem walk + regex per file. No LLM calls.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuid } from 'uuid';
import type { Concern } from '@tetherline/shared';

export interface ObserveOptions {
  repoPath: string;
  allFiles: string[];
  modules: Array<{ name: string; pathPrefix: string }>;
  /** Cap on returned concerns so we don't drown the user. */
  max?: number;
}

const TODO_RE = /\b(?:TODO|FIXME|HACK|XXX)\b/g;
const LONG_FILE_THRESHOLD = 500;
const TODO_CLUSTER_THRESHOLD = 3;
const CODE_EXTENSIONS = /\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php)$/;

export function observeCode(opts: ObserveOptions): Concern[] {
  const out: Concern[] = [];
  const max = opts.max ?? 12;

  // Pass 1: per-file signals (TODO clusters, long files).
  for (const rel of opts.allFiles) {
    if (out.length >= max) break;
    if (!CODE_EXTENSIONS.test(rel)) continue;
    const full = path.join(opts.repoPath, rel);
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch { continue; }

    const lines = content.split('\n');
    const todos = (content.match(TODO_RE) ?? []).length;

    if (todos >= TODO_CLUSTER_THRESHOLD) {
      out.push({
        id: uuid(),
        sessionId: '',
        severity: 'warning',
        category: 'other',
        title: `${todos} TODO/FIXME markers in ${path.basename(rel)}`,
        description:
          `${rel} has a cluster of ${todos} unresolved TODO/FIXME notes. ` +
          'These are good candidates for ticket creation if they\'re still relevant, ' +
          'or for cleanup if they\'re stale.',
        affectedFiles: [rel],
        commitHashes: [],
        codeReferences: [],
        acknowledged: false,
      });
    }

    if (lines.length > LONG_FILE_THRESHOLD) {
      out.push({
        id: uuid(),
        sessionId: '',
        severity: 'info',
        category: 'other',
        title: `${rel} is ${lines.length} lines long`,
        description:
          `Files over ${LONG_FILE_THRESHOLD} lines tend to grow concerns. ` +
          'Worth considering whether this could be split when you next touch it.',
        affectedFiles: [rel],
        commitHashes: [],
        codeReferences: [],
        acknowledged: false,
      });
    }
  }

  // Pass 2: per-module test coverage check.
  for (const mod of opts.modules) {
    if (out.length >= max) break;
    const moduleFiles = opts.allFiles.filter(f => f.startsWith(mod.pathPrefix + '/'));
    if (moduleFiles.length < 3) continue; // tiny modules don't need tests
    const hasTests = moduleFiles.some(f =>
      /test|spec|__tests?__/i.test(f) || /\.(test|spec)\./i.test(path.basename(f)),
    );
    if (!hasTests) {
      out.push({
        id: uuid(),
        sessionId: '',
        severity: 'info',
        category: 'missing_tests',
        title: `${mod.name} has no detectable tests`,
        description:
          `Module \`${mod.name}\` (${moduleFiles.length} files) doesn\'t have a co-located ` +
          'test directory or *.test.* file. Worth adding coverage when you next touch it.',
        affectedFiles: moduleFiles.slice(0, 5),
        commitHashes: [],
        codeReferences: [],
        acknowledged: false,
      });
    }
  }

  return out;
}
