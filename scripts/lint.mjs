#!/usr/bin/env node
/**
 * Zero-dep fast lint (H3). Deterministic, ~1s, no toolchain to install
 * — the cheapest autonomous quality gate. Rules tuned to THIS codebase
 * so it has near-zero false positives (a noisy gate is a useless gate):
 *
 *   FAIL  raw color literal (#rgb / rgb() / rgba() / hsl()) in frontend
 *         src that is NOT a `var(--token, fallback)` — theme discipline.
 *   FAIL  console.log( left in non-test src — debug leftover, prod bar.
 *   WARN  `: any` / `as any` in src — visibility on the no-corners bar.
 *
 * Exit non-zero on any FAIL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['packages/frontend/src', 'packages/backend/src', 'packages/shared/src', 'packages/cli/src'];
const fails = [];
const warns = [];

function walk(dir) {
  let out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) out = out.concat(walk(p));
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p);
  }
  return out;
}

// Bare hex / rgb() / hsl(). NOT an HTML numeric entity (&#1234;).
const RAW_COLOR = /((?<!&)#[0-9a-fA-F]{3,8}\b|rgba?\(|hsl\()/;
for (const root of ROOTS) {
  let files = [];
  try { files = walk(root); } catch { continue; }
  const isFrontend = root.startsWith('packages/frontend');
  for (const f of files) {
    if (/(\.test\.|\/scenes\/)/.test(f)) continue; // scenes/tests may carry fixtures
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const ln = i + 1;
      if (isFrontend && RAW_COLOR.test(line)) {
        // Allowed: a token with a fallback — var(--x, #fallback) / oklch tokens.
        const stripped = line.replace(/var\(--[^)]*\)/g, '');
        if (RAW_COLOR.test(stripped) && !/oklch\(/.test(line.slice(0, line.search(RAW_COLOR)))) {
          fails.push(`${f}:${ln}  raw color literal (use a theme token / var())  » ${line.trim().slice(0, 90)}`);
        }
      }
      // console.log is legitimate in the CLI/server (banners, shutdown,
      // digest). It is a debug leftover only in the FRONTEND bundle.
      if (isFrontend && /\bconsole\.log\(/.test(line)) {
        fails.push(`${f}:${ln}  frontend console.log (remove debug logging)  » ${line.trim().slice(0, 80)}`);
      }
      if (/(:\s*any\b|\bas any\b)/.test(line)) {
        warns.push(`${f}:${ln}  any-typed  » ${line.trim().slice(0, 80)}`);
      }
    });
  }
}

if (warns.length) {
  console.warn(`lint: ${warns.length} \`any\` site(s) (warn):`);
  for (const w of warns.slice(0, 20)) console.warn('  ' + w);
  if (warns.length > 20) console.warn(`  …and ${warns.length - 20} more`);
}
if (fails.length) {
  console.error(`\nlint: ${fails.length} FAIL:`);
  for (const x of fails) console.error('  ✗ ' + x);
  process.exit(1);
}
console.log(`lint: clean (${warns.length} any-warns, 0 fails)`);
