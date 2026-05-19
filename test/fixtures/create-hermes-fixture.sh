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

# Commit dates MUST be relative to "now", not hardcoded. The session
# manager early-returns for entryMode 'updates' when no commits fall in
# the sinceDays window — hardcoded dates silently rot past that window
# as wall-clock advances and the whole hermes suite 404s on briefings.
INIT_DATE="$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)"
FEAT_DATE="$(date -u -d '5 days ago' +%Y-%m-%dT%H:%M:%SZ)"

git init -q -b main

mkdir -p core utils auth payments

cat > README.md <<'EOF'
# fixture-hermes

Multi-module fixture for the Hermes radial-map e2e flow. Each top-level
directory becomes its own module so the project briefing has enough
satellites for the test to mean something.

## core
The capture pipeline. Every payment goes through capture.ts, which is
wrapped in an idempotency store so retries with the same key never
double-charge. core/idempotency.ts is the in-memory backing store.

## utils
A dev-only logger. In production, structured JSON goes through the
observability pipeline instead — utils/log.ts is just a print helper.

## auth
Issues short-lived JWTs and rotates the signing key from the system
keyring. The non-obvious part: in dev mode it falls back to a static
cookie so local tests don't need a keyring. auth/jwt.ts owns
issueToken and rotateKey.

## payments
Double-entry ledger. Every capture writes a debit + credit pair. The
constraint that surprises people: rows are append-only, never updated
in place — corrections are reversal entries. payments/ledger.ts is the
whole module.
EOF

cat > package.json <<'EOF'
{ "name": "fixture-hermes", "version": "0.0.1", "type": "module" }
EOF

cat > core/capture.ts <<'EOF'
import { IdempotencyStore } from './idempotency.js';
const store = new IdempotencyStore();
export async function capture(amount: number, key: string) {
  const prior = store.get(key);
  if (prior) return prior;
  const result = { ok: amount > 0 };
  store.put(key, result);
  return result;
}
EOF
cat > utils/log.ts <<'EOF'
// Dev-only logger. In production, structured JSON goes through the
// observability pipeline instead — this is just a print helper.
export function log(msg: string) { if (process.env.NODE_ENV !== 'production') console.log('[fx]', msg); }
EOF
cat > auth/jwt.ts <<'EOF'
// Issues short-lived JWTs (15 min) and rotates the signing key from the
// system keyring. The non-obvious part: in dev mode, falls back to a
// static cookie so local tests don't need a keyring.
export function issueToken(userId: string) { return `tok_${userId}`; }
export function rotateKey() { /* pulls next key from keyring */ }
EOF
cat > payments/ledger.ts <<'EOF'
// Double-entry bookkeeping — every capture writes a debit + credit pair.
// The constraint: rows are append-only, never updated in place.
export function record(amount: number) { /* ledger insert */ }
EOF

GIT_AUTHOR_DATE="$INIT_DATE" GIT_COMMITTER_DATE="$INIT_DATE" \
  git add -A
GIT_AUTHOR_DATE="$INIT_DATE" GIT_COMMITTER_DATE="$INIT_DATE" \
  git commit -q -m "Initial multi-module scaffolding"

cat > core/idempotency.ts <<'EOF'
export class Store { private m = new Map<string, unknown>(); get(k: string) { return this.m.get(k); } put(k: string, v: unknown) { this.m.set(k, v); } }
EOF
GIT_AUTHOR_DATE="$FEAT_DATE" GIT_COMMITTER_DATE="$FEAT_DATE" \
  git add -A
GIT_AUTHOR_DATE="$FEAT_DATE" GIT_COMMITTER_DATE="$FEAT_DATE" \
  git commit -q -m "Add idempotency store for safe retries"

echo "fixture ready: $DEST"
git log --oneline
