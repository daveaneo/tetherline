#!/usr/bin/env bash
# Hermes-flow fixture: a tiny repo with multiple top-level modules so
# the cache warmer detects more than one module (the briefing radial
# map needs ≥2 children to be meaningful).
set -euo pipefail

DEST="${1:-/tmp/tetherline-fixture-hermes}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@tetherline.test'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@tetherline.test'

git init -q -b main

mkdir -p core utils auth payments

cat > README.md <<'EOF'
# fixture-hermes

Multi-module fixture for the Hermes radial-map e2e flow. Each top-level
directory becomes its own module so the project briefing has enough
satellites for the test to mean something.

## core
The capture pipeline.

## utils
Logging and shared helpers.

## auth
Token issuance and rotation.

## payments
Money movement with idempotency guards.
EOF

cat > package.json <<'EOF'
{ "name": "fixture-hermes", "version": "0.0.1", "type": "module" }
EOF

cat > core/capture.ts <<'EOF'
export async function capture(amount: number) { return { ok: amount > 0 }; }
EOF
cat > utils/log.ts <<'EOF'
export function log(msg: string) { console.log('[fx]', msg); }
EOF
cat > auth/jwt.ts <<'EOF'
export function issueToken(userId: string) { return `tok_${userId}`; }
EOF
cat > payments/ledger.ts <<'EOF'
export function record(amount: number) { /* ledger insert */ }
EOF

GIT_AUTHOR_DATE='2026-04-01T10:00:00Z' GIT_COMMITTER_DATE='2026-04-01T10:00:00Z' \
  git add -A
GIT_AUTHOR_DATE='2026-04-01T10:00:00Z' GIT_COMMITTER_DATE='2026-04-01T10:00:00Z' \
  git commit -q -m "Initial multi-module scaffolding"

cat > core/idempotency.ts <<'EOF'
export class Store { private m = new Map<string, unknown>(); get(k: string) { return this.m.get(k); } put(k: string, v: unknown) { this.m.set(k, v); } }
EOF
GIT_AUTHOR_DATE='2026-04-15T10:00:00Z' GIT_COMMITTER_DATE='2026-04-15T10:00:00Z' \
  git add -A
GIT_AUTHOR_DATE='2026-04-15T10:00:00Z' GIT_COMMITTER_DATE='2026-04-15T10:00:00Z' \
  git commit -q -m "Add idempotency store for safe retries"

echo "fixture ready: $DEST"
git log --oneline
