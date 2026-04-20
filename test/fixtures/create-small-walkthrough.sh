#!/usr/bin/env bash
# Tiny fixture repo used by integration tests.
# Deterministic: fixed commit dates/authors so SHAs are stable.
set -euo pipefail

DEST="${1:-/tmp/tetherline-fixture-small-walkthrough}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@tetherline.test'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@tetherline.test'

git init -q -b main

mkdir -p src/core src/utils

cat > README.md <<'EOF'
# fixture-small

Tiny fixture used by Tetherline integration tests. A minimal TypeScript project
with two modules so the analyzer has something to cluster.
EOF

cat > package.json <<'EOF'
{
  "name": "fixture-small",
  "version": "0.0.1",
  "type": "module",
  "scripts": { "build": "tsc" },
  "devDependencies": { "typescript": "^5.0.0" }
}
EOF

cat > src/core/capture.ts <<'EOF'
export interface CaptureParams { amount: number; currency: string; }
export async function capture(params: CaptureParams): Promise<{ ok: boolean }> {
  if (params.amount <= 0) throw new Error('amount must be positive');
  return { ok: true };
}
EOF

cat > src/utils/log.ts <<'EOF'
export function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log('[fixture]', msg);
}
EOF

GIT_AUTHOR_DATE='2026-04-01T10:00:00Z' GIT_COMMITTER_DATE='2026-04-01T10:00:00Z' \
  git add -A
GIT_AUTHOR_DATE='2026-04-01T10:00:00Z' GIT_COMMITTER_DATE='2026-04-01T10:00:00Z' \
  git commit -q -m "Initial project scaffolding"

cat > src/core/idempotency.ts <<'EOF'
export class IdempotencyStore {
  private map = new Map<string, unknown>();
  get(key: string) { return this.map.get(key); }
  put(key: string, value: unknown) { this.map.set(key, value); }
}
EOF

GIT_AUTHOR_DATE='2026-04-15T10:00:00Z' GIT_COMMITTER_DATE='2026-04-15T10:00:00Z' \
  git add -A
GIT_AUTHOR_DATE='2026-04-15T10:00:00Z' GIT_COMMITTER_DATE='2026-04-15T10:00:00Z' \
  git commit -q -m "Add idempotency store for safe retries"

# Edit capture to use the store
cat > src/core/capture.ts <<'EOF'
import { IdempotencyStore } from './idempotency.js';

const store = new IdempotencyStore();

export interface CaptureParams { amount: number; currency: string; idempotencyKey: string; }

export async function capture(params: CaptureParams): Promise<{ ok: boolean; cached: boolean }> {
  if (params.amount <= 0) throw new Error('amount must be positive');
  const prior = store.get(params.idempotencyKey);
  if (prior) return { ok: true, cached: true };
  const result = { ok: true, cached: false };
  store.put(params.idempotencyKey, result);
  return result;
}
EOF

GIT_AUTHOR_DATE='2026-04-18T10:00:00Z' GIT_COMMITTER_DATE='2026-04-18T10:00:00Z' \
  git add -A
GIT_AUTHOR_DATE='2026-04-18T10:00:00Z' GIT_COMMITTER_DATE='2026-04-18T10:00:00Z' \
  git commit -q -m "Wire idempotency into capture so retries are safe"

echo "fixture ready: $DEST"
echo "commits:"
git log --oneline
