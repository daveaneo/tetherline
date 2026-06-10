/**
 * Flow evidence: resolves a free-form target ("core") to a module and gathers
 * the REAL files + file-level import edges the authoring LLM needs to ground
 * its diagram. Critically resolves Python dotted imports
 * (`from core.data_cleaner import X`) to file paths so edge support works on
 * Python repos like personalforge (the import-parser caveat from the plan).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildFlowEvidence } from '../../packages/backend/src/intelligence/flow-evidence.js';

let dir: string;
const mods = [
  { modulePath: 'core', keyFiles: ['core/web_collector.py', 'core/data_cleaner.py', 'core/pair_generator.py'] },
  { modulePath: 'utils', keyFiles: ['utils/helpers.py'] },
];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ev-'));
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'utils'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core/web_collector.py'), 'import requests\n');
  // data_cleaner imports web_collector (dotted) → an edge web→cleaner direction.
  fs.writeFileSync(path.join(dir, 'core/data_cleaner.py'), 'from core.web_collector import WebCollector\n');
  fs.writeFileSync(path.join(dir, 'core/pair_generator.py'), 'from core.data_cleaner import DataCleaner\n');
  fs.writeFileSync(path.join(dir, 'utils/helpers.py'), 'x = 1\n');
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('buildFlowEvidence', () => {
  it('resolves the target module and returns its files', () => {
    const ev = buildFlowEvidence('core', { repoPath: dir, modules: mods });
    expect(ev).toBeTruthy();
    expect(ev!.moduleName).toBe('core');
    expect(ev!.files).toEqual(mods[0].keyFiles);
  });

  it('resolves Python dotted imports into file-level edges', () => {
    const ev = buildFlowEvidence('core', { repoPath: dir, modules: mods })!;
    const has = (from: string, to: string) =>
      ev.importEdges.some(e => e.from === from && e.to === to);
    // data_cleaner imports web_collector; pair_generator imports data_cleaner.
    expect(has('core/data_cleaner.py', 'core/web_collector.py')).toBe(true);
    expect(has('core/pair_generator.py', 'core/data_cleaner.py')).toBe(true);
  });

  it('returns null for an unknown target', () => {
    expect(buildFlowEvidence('nonsense-xyz', { repoPath: dir, modules: mods })).toBeNull();
  });
});
