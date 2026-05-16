#!/usr/bin/env node
/**
 * `pnpm verify` (H2) — the autonomous gate.
 *
 * Runs every quality gate INDEPENDENTLY (no short-circuit, so one red
 * gate never hides another), prints one aggregate table, exits
 * non-zero if any hard gate failed. This is the single command the
 * polish loop runs after every change — deterministic, no human.
 *
 *   typecheck   tsc, 4 packages          (hard)
 *   lint        zero-dep fast lint        (hard)
 *   unit        vitest test/unit          (hard)
 *   scenes      playwright pixel + console (hard; needs dev server)
 *
 * `--no-scenes` skips the browser gate (e.g. no dev server).
 */
import { spawnSync } from 'node:child_process';

const skipScenes = process.argv.includes('--no-scenes');

const GATES = [
  { name: 'typecheck', cmd: 'pnpm', args: ['-s', 'typecheck'] },
  { name: 'lint', cmd: 'node', args: ['scripts/lint.mjs'] },
  { name: 'unit', cmd: 'pnpm', args: ['-s', 'test:unit'] },
  ...(skipScenes ? [] : [{ name: 'scenes', cmd: 'pnpm', args: ['-s', 'scenes'] }]),
];

const results = [];
for (const g of GATES) {
  process.stdout.write(`\n──── ${g.name} ────\n`);
  const t0 = Date.now();
  const r = spawnSync(g.cmd, g.args, { stdio: 'inherit', encoding: 'utf8' });
  results.push({ name: g.name, ok: r.status === 0, ms: Date.now() - t0 });
}

console.log('\n════ verify summary ════');
let failed = false;
for (const r of results) {
  const mark = r.ok ? '✅ PASS' : '❌ FAIL';
  if (!r.ok) failed = true;
  console.log(`  ${mark}  ${r.name.padEnd(10)} ${(r.ms / 1000).toFixed(1)}s`);
}
console.log('════════════════════════');
if (failed) {
  console.error('verify: FAIL — fix the red gate(s) above.');
  process.exit(1);
}
console.log('verify: ALL GREEN');
