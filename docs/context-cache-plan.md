# Context Cache Plan (v2)

## Core Insight

Don't start with LLM calls. Start with what's free: READMEs, manifests, import graphs, file structure. The LLM refines and fills gaps — it doesn't discover from scratch. And on warm start, zero LLM calls. Summaries update lazily when visited, not eagerly on session start.

## Three Phases of Knowledge

### Phase 1: Free Intelligence (no LLM, instant)

**README parsing** — scan for README.md at root and in every directory. Parse structurally: H2 headings map to tagged chunks. "## Database" with two paragraphs below it IS the database module summary. Extract:
- Project purpose (first paragraph or "## About")
- Architecture descriptions ("## Architecture", "## Structure")
- Module descriptions (any H2 that matches a directory name)
- Setup/usage info ("## Getting Started", "## Usage")

**Manifest parsing** — extract structured data directly:
- `package.json`: name, description, dependencies (= tech stack), scripts (= workflows)
- `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements.txt`: same pattern
- `docker-compose.yml`: services = architectural components
- `.env.example`: configuration surface area

**Import graph** — parse import/require/use statements from entry point files and high-connectivity files. This gives the actual dependency tree between modules. Factual, not guessed. Store as edges: `file A imports file B`.

**File metadata** — for every tracked file: path, size, language (from extension), last modified date. No content reading needed for most files.

**Connectivity ranking** — count how many other files import each file. The most-imported files are the most architecturally important. This determines which files get LLM budget.

### Phase 2: LLM Fills Gaps (targeted, minimal)

Only call the LLM for:
1. **Module detection** — send the file tree + README structure + manifest to Claude and ask: "What are the logical modules in this project?" One call. Cache the result.
2. **Modules without READMEs** — if a directory has no README and no parent README that describes it, ask Claude to summarize it from its file list + import graph.
3. **High-connectivity files without obvious purpose** — files imported by many others that aren't self-descriptive. Skip config files, type definitions, tests, small utilities.
4. **Project synthesis** — one call to synthesize the overall context from README chunks + manifest data + module summaries. This is the master summary.

**What we DON'T call the LLM for:**
- Files with fewer than 50 lines (the code itself is the summary)
- Test files (purpose is obvious from naming)
- Config/type/declaration files (parseable without AI)
- Any file where a README already describes its purpose
- Any module where a README section covers it

Cold start estimate for a 200-file project: module detection (1 call) + ~3 uncovered modules (3 calls) + ~10 important ungapped files (1 batch call) + project synthesis (1 call) = **~6 LLM calls, ~15 seconds**. Down from 29 calls / 60 seconds in v1.

### Phase 3: Lazy Refinement (during session, on demand)

Summaries don't need to be perfect at session start. They refine as the user explores:
- When the user visits a module, if its summary is low-confidence, re-summarize it then (with the actual code now loaded)
- When the user asks about a file, generate a detailed file summary and cache it
- When the AI narrates an area, the narration itself becomes a cached summary for that area
- When the user asks a Q&A question, cache the Q&A pair keyed to the relevant file/module

This means the cache gets richer the more you use it. First session: mostly README-derived. Fifth session: deeply detailed from accumulated AI analysis and user interactions.

## Cache Levels

### Project Cache
- `summary`: one paragraph (from README + LLM synthesis)
- `purpose`: one sentence
- `tech_stack`: parsed from manifests
- `module_map`: the LLM-detected module grouping
- `trigger_hashes`: README hash, manifest hash, module count
- `confidence`: high (from README) / medium (LLM-generated) / low (heuristic)

### Module Cache
- `summary`: one paragraph (from README section or LLM)
- `source`: 'readme' | 'llm' | 'heuristic' — where the summary came from
- `key_files`: top 5 by connectivity ranking
- `internal_imports`: which other modules this depends on
- `file_hash_snapshot`: for staleness detection
- `confidence`: 0.0-1.0

### File Cache
- `summary`: one sentence (from LLM, README, or heuristic)
- `content_hash`: SHA-256 for staleness
- `connectivity`: how many files import this one
- `role`: 'entry' | 'utility' | 'config' | 'test' | 'type' | 'model' | 'other'
- `exports`: key exported names (parsed, not LLM)

### Q&A Cache (new — not in v1)
- `question`: what was asked
- `answer`: what the AI said
- `context_key`: file path or module path this relates to
- `session_id`: which session produced this
- Similar questions can reuse answers (fuzzy match on question text)

## Staleness Model

Not binary. Confidence decays:

| Scenario | Confidence |
|---|---|
| Summary from unchanged code | 1.0 (fresh) |
| Summary from last week, minor formatting change in one file | 0.8 (probably still valid) |
| Summary from last month, several files changed | 0.4 (likely stale) |
| Code was completely rewritten | 0.0 (invalid) |

Calculation:
```
confidence = base_confidence * decay_factor * change_factor

decay_factor = max(0.5, 1.0 - (days_since_generated / 90))
change_factor = 1.0 - (changed_lines / total_lines)
```

When composing context, include summaries with confidence > 0.3. Below that, treat as unknown and let the LLM work from raw code if needed.

Re-summarize when confidence < 0.3 AND the user is actively viewing that module (lazy, not eager).

## Warm Start Flow (Zero LLM Calls)

1. `git diff --name-only HEAD <cached_head>` → list of changed files
2. Update file hashes for changed files
3. Update confidence scores for affected modules (decay based on changes)
4. Compose context from existing summaries + raw diffs of changed files
5. The LLM sees: "Here's what this project does [cached, high confidence] and here's what changed [raw diff]"
6. Done. Session starts instantly.

Re-summarization happens lazily: when the user explores a stale module, the system says "let me take a fresh look at this..." and re-summarizes in the background.

## Context Composition

### Token Budget Strategy

Not just "fill until budget runs out." Prioritize by relevance:

1. **Always include:** Project summary (~200 tokens)
2. **If discussing a module:** That module's summary + its key file summaries (~400 tokens)
3. **If discussing a file:** The file's actual code (truncated to budget)
4. **Relevant Q&A:** Past Q&A pairs for this area (~200 tokens)
5. **Fill remaining budget:** Adjacent module summaries by import graph proximity

### Relevance Matching

When the user asks a question, don't just match by file path. Extract keywords and match against cached summaries:
- "How does authentication work?" → match "auth" against module names, file names, and summary text
- Include the top 3 matching modules/files by keyword overlap
- This means the AI gets relevant context even when the user doesn't name specific files

## Import Graph Details

Parse these patterns (no LLM needed):
- JS/TS: `import ... from '...'`, `require('...')`
- Python: `import ...`, `from ... import ...`
- Rust: `use ...`, `mod ...`
- Go: `import "..."`

Only parse entry points + top-20 files by connectivity on first pass. Parse remaining files lazily. The import graph doesn't need to be complete to be useful — the top-connected files give you 80% of the architecture.

Store as adjacency list in the module cache: `{ "src/auth/middleware.ts": ["src/db/session.ts", "src/config.ts"] }`.

## New Files

```
packages/backend/src/cache/
  hash-utils.ts           — SHA-256 hashing for files and strings
  readme-parser.ts        — structural README parsing (headings → tagged chunks)
  manifest-parser.ts      — extract structured data from package.json, etc.
  import-parser.ts        — parse import statements for dependency graph
  diff-detector.ts        — find changed files, compute confidence decay
  warmer.ts               — orchestrate cold start (free intel → LLM gaps → cache)
  context-composer.ts     — assemble context documents with relevance matching

packages/backend/src/db/repositories/
  context-cache-repo.ts   — CRUD for all cache tables

packages/backend/src/intelligence/prompts/
  context-cache.ts        — prompts for module detection, gap filling, synthesis
```

## DB Tables

```sql
context_cache_project    — summary, purpose, tech_stack, module_map, trigger_hashes, confidence
context_cache_module     — summary, source, key_files, imports, file_hash_snapshot, confidence
context_cache_file       — summary, content_hash, connectivity, role, exports, confidence
context_cache_qa         — question, answer, context_key, session_id, created_at
```

## Build Order

1. **Foundation (no LLM):** hash-utils, readme-parser, manifest-parser, import-parser, DB tables + repo
2. **Diff detection:** diff-detector with confidence scoring
3. **Free intelligence pass:** warm from READMEs + manifests + imports (zero LLM calls)
4. **LLM gap filling:** context-cache prompts, warmer (targeted calls only)
5. **Context composer:** assembly + relevance matching + token budgeting
6. **Integration:** wire into system prompt, analyzer, skills, manager

## Efficiency Summary

| Metric | v1 Plan | v2 Plan |
|---|---|---|
| Cold start LLM calls | ~29 | ~6 |
| Cold start time | ~60s | ~15s |
| Warm start LLM calls | ~3-4 | 0 |
| Warm start time | <10s | <1s |
| Cache miss handling | Eager re-summarize | Lazy on visit |
| README usage | Not used | Primary source |
| Import graph | Not used | Free architecture |
| Q&A caching | Not used | Reusable answers |
