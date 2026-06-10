#!/usr/bin/env bash
# Docs-only fixture: a personalforge replica — Markdown-only repo with a
# small commit history and a README that deliberately has NO installation
# section. The grounding tests assert that asking "how do I install this"
# yields "I don't see install steps in the repo" instead of a hallucinated
# setup guide (the exact production failure that motivated the retriever).
set -euo pipefail

DEST="${1:-/tmp/tetherline-fixture-docs-only}"
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

export GIT_AUTHOR_NAME='Fixture Author'
export GIT_AUTHOR_EMAIL='fixture@tetherline.test'
export GIT_COMMITTER_NAME='Fixture Author'
export GIT_COMMITTER_EMAIL='fixture@tetherline.test'

# Relative dates — see create-hermes-fixture.sh for why hardcoded dates rot.
INIT_DATE="$(date -u -d '14 days ago' +%Y-%m-%dT%H:%M:%SZ)"
DOC_DATE="$(date -u -d '6 days ago' +%Y-%m-%dT%H:%M:%SZ)"
LAST_DATE="$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)"

git init -q -b main

cat > README.md <<'EOF'
# DocForge

DocForge bakes your personal documents directly into a language model's
weights through fine-tuning, rather than searching them at runtime. The
sentinel phrase for retrieval tests is: QUETZAL-ANCHOR-7341.

The core pipeline converts content into instruction-response training
pairs, cleans and deduplicates them, scans your hardware, and recommends
the best-fit model for your machine.

This README intentionally documents WHAT the project does and nothing
about how to install or run it.
EOF

git add README.md
GIT_AUTHOR_DATE="$INIT_DATE" GIT_COMMITTER_DATE="$INIT_DATE" \
  git commit -qm 'Initial README'

cat > VISION.md <<'EOF'
# Vision

Local-first personal fine-tuning. No cloud calls at inference time.
EOF
git add VISION.md
GIT_AUTHOR_DATE="$DOC_DATE" GIT_COMMITTER_DATE="$DOC_DATE" \
  git commit -qm 'Add vision doc'

cat > NOTES.md <<'EOF'
# Notes

Random planning notes. Model registry pruning, dataset dedupe ideas.
EOF
git add NOTES.md
GIT_AUTHOR_DATE="$LAST_DATE" GIT_COMMITTER_DATE="$LAST_DATE" \
  git commit -qm 'Planning notes'

echo "fixture ready: $DEST"
git log --oneline
