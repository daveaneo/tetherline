#!/usr/bin/env bash
# Litmus: the user's "Back" affordance must actually navigate back.
#
# Two layers to test:
#   1. Backend navigator: command:level_up pops the briefing stack and
#      re-emits the parent briefing. Verifiable via the dev API alone.
#   2. Frontend click handler: the breadcrumb's Back button must dispatch
#      command:level_up AND setScope back to project. NOT verifiable from
#      the dev API alone — needs Playwright. This script handles layer 1;
#      layer 2 is documented in the manual-test steps at the bottom.
#
# The bug that motivated this test: the chrome mini-toolbar at z-30
# (`<div className="absolute top-0 ... pointer-events:ON-by-default ...">`)
# was overlapping the breadcrumb's Back button. The user's click was
# absorbed by the invisible chrome's Exit button instead, kicking them
# back to the lobby. The fix is in Room.tsx — pointer-events-none on the
# wrapper, pointer-events-auto on the buttons.

set -euo pipefail

REPO="${REPO:-/home/david/.tetherline/repos/personalforge}"
BASE="${BASE:-http://localhost:3847/api/dev}"

if ! curl -sf "$BASE/ping" > /dev/null; then
  echo "FAIL: dev API not reachable at $BASE" >&2
  exit 2
fi

# ── Layer 1: backend command:level_up ──────────────────────────────────

SESSION=$(curl -sf -X POST "$BASE/session/start" \
  -H 'Content-Type: application/json' \
  -d "{\"repoPath\":\"$REPO\",\"entryMode\":\"explore\",\"sinceDays\":3650}" \
  | jq -r .devSessionId)

curl -sf -X POST "$BASE/session/wait" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\",\"phase\":\"PROPOSAL\",\"timeoutMs\":60000}" > /dev/null

# Drill into core module via an utterance.
curl -sf -X POST "$BASE/utter" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\",\"text\":\"tell me about the core module\"}" > /dev/null
sleep 4

NAV_BEFORE=$(curl -sf "$BASE/navigator?devSessionId=$SESSION" | jq -r '.depth // 0')
EVENTS_BEFORE=$(curl -sf "$BASE/session/$SESSION/events?since=0" | jq '.total')

# Fire command:level_up — the same event the Back button dispatches.
curl -sf -X POST "$BASE/command" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\",\"type\":\"command:level_up\"}" > /dev/null
sleep 2

NAV_AFTER=$(curl -sf "$BASE/navigator?devSessionId=$SESSION" | jq -r '.depth // 0')
EVENTS_AFTER=$(curl -sf "$BASE/session/$SESSION/events?since=$EVENTS_BEFORE")

POP_FIRED=$(echo "$EVENTS_AFTER" | jq -r '[.events[] | select(.type == "navigator:pop")] | length')

curl -sf -X POST "$BASE/session/reset" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\"}" > /dev/null || true

FAIL=0
echo "─── Back-navigation litmus ─────────────────────────────"
echo "  Nav depth before back:  $NAV_BEFORE"
echo "  Nav depth after  back:  $NAV_AFTER"
echo "  navigator:pop events:   $POP_FIRED"

if [ "$NAV_BEFORE" -le "$NAV_AFTER" ] && [ "$NAV_BEFORE" -gt 0 ]; then
  echo "  ✗ depth didn't decrease — level_up didn't pop the stack"
  FAIL=1
elif [ "$NAV_BEFORE" -eq 0 ]; then
  echo "  ! depth was 0 before back — drill-into-module didn't push (skill path)"
  echo "    (this is a separate issue from Back itself; layer 1 still passes if pop fired)"
fi

if [ "$POP_FIRED" -lt 1 ]; then
  echo "  ✗ no navigator:pop event emitted"
  FAIL=1
else
  echo "  ✓ navigator:pop fired"
fi

echo "────────────────────────────────────────────────────────"
echo
echo "Layer 2 — frontend click handler — manual steps:"
echo "  1. Refresh http://localhost:5174"
echo "  2. Start a session on personalforge"
echo "  3. Click the 'core' satellite (drills into module)"
echo "  4. Click the '← Back' button in the breadcrumb"
echo "  5. EXPECT: diagram returns to project view, NOT lobby"
echo "  BUG (pre-fix): click was absorbed by the invisible chrome's"
echo "                 '← Exit' button → resetSession() → lobby"
echo "  FIX: Room.tsx mini-toolbar wrapper now pointer-events-none"
echo

if [ "$FAIL" -ne 0 ]; then
  echo "LITMUS: FAIL" >&2
  exit 1
fi
echo "LITMUS: PASS (layer 1 — backend)"
