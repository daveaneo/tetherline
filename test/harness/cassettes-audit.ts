#!/usr/bin/env tsx
/**
 * Print cassette cache health: total size, per-namespace counts, biggest 10,
 * and orphans (present on disk but never hit during last run).
 *
 *   pnpm test:cassettes:audit
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const CASSETTE_DIR = path.join(ROOT, 'test/cassettes');

interface Entry { path: string; namespace: string; key: string; size: number; mtime: Date; }

function walk(dir: string): Entry[] {
  if (!fs.existsSync(dir)) return [];
  const out: Entry[] = [];
  for (const ns of fs.readdirSync(dir)) {
    const nsPath = path.join(dir, ns);
    if (!fs.statSync(nsPath).isDirectory()) continue;
    for (const f of fs.readdirSync(nsPath)) {
      if (!f.endsWith('.yaml')) continue;
      const p = path.join(nsPath, f);
      const st = fs.statSync(p);
      out.push({ path: p, namespace: ns, key: f.replace(/\.yaml$/, ''), size: st.size, mtime: st.mtime });
    }
  }
  return out;
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}M`;
}

const entries = walk(CASSETTE_DIR);
const total = entries.reduce((s, e) => s + e.size, 0);

console.log(`Cassette audit — ${CASSETTE_DIR}`);
console.log(`  total files: ${entries.length}`);
console.log(`  total size:  ${fmt(total)}`);

// Per-namespace
const byNs = new Map<string, { count: number; size: number }>();
for (const e of entries) {
  const cur = byNs.get(e.namespace) ?? { count: 0, size: 0 };
  cur.count += 1; cur.size += e.size;
  byNs.set(e.namespace, cur);
}
console.log('\nPer namespace:');
[...byNs.entries()]
  .sort((a, b) => b[1].size - a[1].size)
  .forEach(([ns, { count, size }]) => {
    const over = count > 50 ? ' ⚠ OVER CAP' : '';
    console.log(`  ${count.toString().padStart(4)}  ${fmt(size).padStart(8)}  ${ns}${over}`);
  });

console.log('\nBiggest 10:');
entries.sort((a, b) => b.size - a.size).slice(0, 10).forEach(e => {
  console.log(`  ${fmt(e.size).padStart(8)}  ${e.namespace}/${e.key}`);
});

const MAX_MB = 10;
if (total > MAX_MB * 1024 * 1024) {
  console.error(`\n❌ total cassette size ${fmt(total)} exceeds ${MAX_MB}MB ceiling.`);
  process.exit(1);
}

const overCapNamespaces = [...byNs.entries()].filter(([, v]) => v.count > 50);
if (overCapNamespaces.length > 0) {
  console.error(`\n❌ namespaces over CASSETTE_MAX_PER_TEST=50: ${overCapNamespaces.map(([n]) => n).join(', ')}`);
  process.exit(1);
}

console.log('\n✓ within limits');
