#!/usr/bin/env bash
# Litmus: a user request like "catch me up on what changed in five
# words" must produce a spoken recap that (a) honors the word-limit,
# (b) is relevant to the project, (c) is actually audible (the
# narration must flow through a path the speak-pipeline picks up).
#
# Failure modes this catches:
#   - skill ignores params.word_limit (returns a long recap)
#   - skill narration arrives in skill:result but never becomes audible
#     (no narration:greeting / narration:stream_chunk fires)
#   - the trailing deviation nudge ("Take your time exploring...") is
#     mistaken for the answer

set -euo pipefail

REPO="${REPO:-/home/david/.tetherline/repos/personalforge}"
BASE="${BASE:-http://localhost:3847/api/dev}"
QUESTION="${QUESTION:-catch me up on what changed in five words}"
MAX_WORDS="${MAX_WORDS:-8}"   # allow a little slop (LLMs often give 4-7 for "5 words")
MIN_WORDS="${MIN_WORDS:-2}"
WAIT_MS="${WAIT_MS:-14}"      # seconds to wait for the skill output — natural
                              # phrasing triggers proposal-accept + recursion +
                              # intent classifier + skill LLM, ~10-12s total.

if ! curl -sf "$BASE/ping" > /dev/null; then
  echo "FAIL: dev API not reachable at $BASE" >&2
  exit 2
fi

SESSION=$(curl -sf -X POST "$BASE/session/start" \
  -H 'Content-Type: application/json' \
  -d "{\"repoPath\":\"$REPO\",\"entryMode\":\"explore\",\"sinceDays\":3650}" \
  | jq -r .devSessionId)

# Wait until we're past PROPOSAL — for this test we want to be in the
# normal pipeline, not the proposal-gate (my earlier fix routes >4-word
# utterances through to QA after silently accepting, but for crisper
# diagnostics, start the test post-proposal).
curl -sf -X POST "$BASE/session/wait" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\",\"phase\":\"PROPOSAL\",\"timeoutMs\":60000}" > /dev/null

# Inject the test utterance.
EVENTS_BEFORE=$(curl -sf "$BASE/session/$SESSION/events?since=0" | jq '.total')
curl -sf -X POST "$BASE/utter" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\",\"text\":\"$QUESTION\"}" > /dev/null

# Give the LLM time to produce the skill output. Natural-phrasing
# utterances during PROPOSAL phase go through accept-then-recurse, so
# they take ~10-12s end-to-end vs ~4-6s for an utterance after PROPOSAL.
sleep "$WAIT_MS"

EVENTS_JSON=$(curl -sf "$BASE/session/$SESSION/events?since=$EVENTS_BEFORE")

# Clean up regardless of outcome.
curl -sf -X POST "$BASE/session/reset" \
  -H 'Content-Type: application/json' \
  -d "{\"devSessionId\":\"$SESSION\"}" > /dev/null || true

# ── Assertions ──────────────────────────────────────────────────────

# Pull the skill result for `whats_changed`.
SKILL_NARRATION=$(echo "$EVENTS_JSON" | jq -r '
  .events[]
  | select(.type == "skill:result" and .payload.result.skillName == "whats_changed")
  | .payload.result.narration
' | head -n 1)

# What was actually spoken: anything on the narration/stream_chunk path.
# We DON'T filter out the deviation nudge here — its presence after the
# skill answer is itself a bug (it races the answer through the
# orchestrator's 250ms coalesce and silences the answer). The audible
# winner is the LAST narration emit.
SPOKEN=$(echo "$EVENTS_JSON" | jq -r '
  .events[]
  | select(.type == "narration:greeting" or .type == "narration:stream_chunk" or .type == "narration:briefing")
  | .payload.text
')

# The audible winner — what the orchestrator's coalesce actually speaks
# when multiple greetings arrive in a tight window. Currently the LAST
# greeting wins; if that's the deviation nudge instead of the skill
# answer, the user hears the wrong thing.
LAST_SPOKEN=$(echo "$SPOKEN" | tail -1)

FAIL=0
echo "─── whats_changed-skill litmus ─────────────────────────"
echo "  Question: $QUESTION"

if [ -z "$SKILL_NARRATION" ] || [ "$SKILL_NARRATION" = "null" ]; then
  echo "  ✗ skill:result event for whats_changed never fired"
  FAIL=1
else
  WORD_COUNT=$(echo "$SKILL_NARRATION" | wc -w | tr -d ' ')
  echo "  skill narration: \"$SKILL_NARRATION\""
  echo "  word count: $WORD_COUNT (allowed range: ${MIN_WORDS}–${MAX_WORDS})"
  if [ "$WORD_COUNT" -lt "$MIN_WORDS" ] || [ "$WORD_COUNT" -gt "$MAX_WORDS" ]; then
    echo "  ✗ word count outside expected range — skill is ignoring word_limit"
    FAIL=1
  else
    echo "  ✓ word count honors word_limit"
  fi
fi

if [ -z "$SPOKEN" ]; then
  echo "  ✗ skill narration was never spoken aloud (no narration:* events with skill output)"
  FAIL=1
else
  # The skill narration must be the LAST narration emitted — anything
  # firing after it races through the 250ms greeting coalesce and wins,
  # silencing the actual answer. (Concrete case: a "Take your time
  # exploring..." nudge firing 0ms after the summary made the user hear
  # the nudge, not the summary.)
  if [ -n "$SKILL_NARRATION" ] && [ "$SKILL_NARRATION" != "null" ]; then
    PREFIX=$(echo "$SKILL_NARRATION" | head -c 30)
    if [ "${LAST_SPOKEN:0:30}" = "$PREFIX" ]; then
      echo "  ✓ skill narration was the last narration emitted (audible)"
    else
      echo "  ✗ a later narration:greeting silenced the answer:"
      echo "      skill said:  $(echo "$SKILL_NARRATION" | head -c 80)"
      echo "      LAST spoken: $(echo "$LAST_SPOKEN" | head -c 80)"
      FAIL=1
    fi
  fi
fi

echo "────────────────────────────────────────────────────────"

if [ "$FAIL" -ne 0 ]; then
  echo "LITMUS: FAIL" >&2
  exit 1
fi
echo "LITMUS: PASS"
