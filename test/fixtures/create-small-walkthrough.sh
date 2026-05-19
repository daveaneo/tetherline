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

# Commit dates relative to "now" — hardcoded dates silently rot past
# the entryMode:'updates' sinceDays window as wall-clock advances,
# which makes the manager early-return before warming briefings.
D_INIT="$(date -u -d '21 days ago' +%Y-%m-%dT%H:%M:%SZ)"
D_MID="$(date -u -d '12 days ago' +%Y-%m-%dT%H:%M:%SZ)"
D_LATEST="$(date -u -d '5 days ago' +%Y-%m-%dT%H:%M:%SZ)"

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

GIT_AUTHOR_DATE="$D_INIT" GIT_COMMITTER_DATE="$D_INIT" \
  git add -A
GIT_AUTHOR_DATE="$D_INIT" GIT_COMMITTER_DATE="$D_INIT" \
  git commit -q -m "Initial project scaffolding"

cat > src/core/idempotency.ts <<'EOF'
export class IdempotencyStore {
  private map = new Map<string, unknown>();
  get(key: string) { return this.map.get(key); }
  put(key: string, value: unknown) { this.map.set(key, value); }
}
EOF

GIT_AUTHOR_DATE="$D_MID" GIT_COMMITTER_DATE="$D_MID" \
  git add -A
GIT_AUTHOR_DATE="$D_MID" GIT_COMMITTER_DATE="$D_MID" \
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

GIT_AUTHOR_DATE="$D_LATEST" GIT_COMMITTER_DATE="$D_LATEST" \
  git add -A
GIT_AUTHOR_DATE="$D_LATEST" GIT_COMMITTER_DATE="$D_LATEST" \
  git commit -q -m "Wire idempotency into capture so retries are safe"

echo "fixture ready: $DEST"
echo "commits:"
git log --oneline
