# Context Cache Plan

## What it is

A three-level cache of AI-generated summaries (project, module, file) that updates incrementally and provides rich context to every LLM call. The AI never loses track of what project it's reviewing.

## Three levels

**Project** — one paragraph. What the project does, who it's for, key tech. Regenerated when README/manifest changes or >30% of modules are stale.

**Module** — one paragraph per top-level directory. What it does, key files, dependencies. Regenerated when any file in the module changes.

**File** — one sentence per file. What it does. Regenerated when the file's content hash changes.

## Cache keys

- File: SHA-256 of content. Mismatch = stale.
- Module: snapshot of all file hashes within it. Any change = stale.
- Project: hashes of README + manifest + module count. Change = stale.
- Optimization: store last HEAD commit hash. Use `git diff --name-only` to narrow the diff scan.

## Warming flow

**Cold start (first run):**
1. List tracked files via `git ls-files`
2. Identify modules (top-level directories)
3. Batch-summarize files (10 per LLM call) → ~20 calls for 200 files
4. Summarize each module from its file summaries → ~8 calls
5. Summarize project from module summaries + README → 1 call
6. Total: ~29 calls, ~60 seconds. Runs during greeting narration.

**Warm start (subsequent runs):**
1. Diff against cached hashes → find changed files
2. Re-summarize only changed files → ~1 call
3. Re-summarize stale modules → ~2 calls
4. Optionally re-summarize project → 0-1 calls
5. Total: ~3-4 calls, <10 seconds.

**No changes:** Return immediately. Zero LLM calls.

## Context composition

Every LLM call gets a context document assembled from the cache. Sized to fit the token budget, composed per query type:

| Query type | Content included |
|---|---|
| File focus | Project + module + file summary + actual code |
| Module focus | Project + module + all file summaries |
| Architecture | Project + all module summaries |
| Question | Project + relevant module/file if mentioned |

## Integration points

1. **System prompt** — project context appended to every call
2. **Q&A** — relevant module/file context prepended to questions
3. **Skills** — context composer available in SkillContext
4. **Clustering + narrative prompts** — project context prepended
5. **Session manager** — warms cache before analysis, creates composer

## New files

```
packages/backend/src/cache/
  hash-utils.ts         — SHA-256 hashing
  diff-detector.ts      — finds what changed vs cache
  warmer.ts             — orchestrates incremental re-summarization
  context-composer.ts   — assembles context documents for LLM calls

packages/backend/src/db/repositories/
  context-cache-repo.ts — SQLite CRUD for 3 cache tables

packages/backend/src/intelligence/prompts/
  context-cache.ts      — summarization prompts per level
```

## DB tables

- `context_cache_project` — repo_path (unique), summary, trigger_hashes
- `context_cache_module` — repo_path + module_path (unique), summary, file_hash_snapshot
- `context_cache_file` — repo_path + file_path (unique), summary, content_hash

## Build order

1. Hash utils + DB tables + repository (foundation, no LLM)
2. Diff detector (depends on 1)
3. Summarization prompts (standalone)
4. Warmer (depends on 1, 2, 3)
5. Context composer (depends on 1)
6. Wire into system prompt, analyzer, skills, manager (depends on 4, 5)

## Risks

- Cold start on large repos (500+ files): cap at 300 files, warm rest lazily
- Token budget overflow: composer enforces hard cap, trims from bottom
- Stale cache: content hash comparison is byte-level accurate
