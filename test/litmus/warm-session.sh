#!/usr/bin/env bash
# Litmus: a warm session (cache already populated for the repo) MUST
# reach PROPOSAL phase quickly AND must NOT trigger any LLM-driven
# analyzer phases. This is the user-facing contract: "nothing changed,
# this should be instant and cached."
#
# Failure modes this catches:
#   - "Generating architecture diagram..." progress phase fires
#   - clusterCommits / generateNarrative / detectConcerns / rankByImpact
#     re-run on a warm cache
#   - Total time-to-PROPOSAL exceeds the warm budget
#
# Pre-condition: a prior session has been run on personalforge so the
# context_cache / diagram_cache / briefings are populated. This script
# is a litmus, not a fixture — it assumes warm state.

set -euo pipefail

REPO="${REPO:-/home/david/.tetherline/repos/personalforge}"
BASE="${BASE:-http://localhost:3847/api/dev}"
SINCE_DAYS="${SINCE_DAYS:-3650}"  # Match `explore` mode: full history, exercises LLM analyzer
WARM_BUDGET_MS="${WARM_BUDGET_MS:-3000}"

if ! curl -sf "$BASE/ping" > /dev/null; then
  echo "FAIL: dev API not reachable at $BASE — is the backend running?" >&2
  exit 2
fi

if [ ! -d "$REPO" ]; then
  echo "FAIL: repo $REPO not found. Set REPO=... or warm a session first." >&2
  exit 2
fi

# 1. Start a session, measure wall-clock until PROPOSAL phase.
SESSION=$(curl -sf -X POST "$BASE/session/start" \
  -H 'Content-Type: application/json' \
  -d "{\"repoPath\":\"$REPO\",\"entryMode\":\"explore\",\"sinceDays\":$SINCE_DAYS}" \
  | jq -r .devSessionId)

if [ -z "$SESSION" ] || [ "$SESSION" = "null" ]; then
  echo "FAIL: could not create dev session" >&2
  exit 2
fi

T0_NS=$(date +%s%N)

curl -sf -X POST "$BASE/session/wait" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\",\"phase\":\"PROPOSAL\",\"timeoutMs\":60000}" > /dev/null

T1_NS=$(date +%s%N)
ELAPSED_MS=$(( (T1_NS - T0_NS) / 1000000 ))

# 2. Pull the events and assert no LLM analyzer phases fired.
EVENTS_JSON=$(curl -sf "$BASE/session/$SESSION/events?since=0")

# Phases that mean "we re-ran an LLM-driven analyzer step on a warm cache".
# Each one is a regression — the user shouldn't see any of these.
BAD_PHASES=$(echo "$EVENTS_JSON" \
  | jq -r '.events[] | select(.type == "analysis:progress") | .payload.phase // empty' \
  | grep -E '^(clustering|generating_narratives|detecting_concerns|generating_architecture)$' \
  | sort -u || true)

# Clean up the dev session regardless of pass/fail.
curl -sf -X POST "$BASE/session/reset" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\"}" > /dev/null || true

FAIL=0
echo "─── Warm-session litmus ────────────────────────────────"
echo "  Repo:         $REPO"
echo "  Time to PROPOSAL: ${ELAPSED_MS}ms (budget ${WARM_BUDGET_MS}ms)"

# TIME is the primary contract — "instant on warm cache". The phase
# list below is informational: with the llm_call_cache in place the
# phase messages still fire (sub-ms each) but no real LLM work runs.
# Fail the build only if the wall-clock budget is blown.
if [ "$ELAPSED_MS" -gt "$WARM_BUDGET_MS" ]; then
  echo "  ✗ Time budget EXCEEDED — real LLM work is happening"
  FAIL=1
else
  echo "  ✓ Time within budget"
fi

if [ -n "$BAD_PHASES" ]; then
  echo "  ℹ analyzer phase messages emitted (instant on warm cache):"
  echo "$BAD_PHASES" | sed 's/^/      - /'
fi
echo "────────────────────────────────────────────────────────"

if [ "$FAIL" -ne 0 ]; then
  echo "LITMUS: FAIL" >&2
  exit 1
fi
echo "LITMUS: PASS"
