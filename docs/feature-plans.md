# Feature Plans

## Master Sequence

| Phase | Feature | Effort | Weeks | Depends On |
|-------|---------|--------|-------|------------|
| A | Progressive Zoom (5 visual layers) | L | 1-3 | Nothing |
| B | Smart Updates Mode | M | 3-5 | Benefits from A |
| C | Action Layer (GitHub issues, notes, share) | M | 5-7 | Benefits from A |
| D | Onboarding Mode (multi-day program) | L | 7-9 | Requires A |
| E | Monday Morning Digest | M | 9-11 | Requires B |

---

## Feature 1: Progressive Zoom (Phase A)

### What it is
Five visual layers in the left panel, each with its own visual language. The AI's narration drives which layer is active. Users can say "zoom in" / "zoom out" to move between them.

### The layers
1. **Book Jacket** — Plain language card. Project name, purpose, stats. No diagrams.
2. **Conceptual Flow** — Animated storyboard. "User does X → system does Y → result is Z." Sequential panels with icons.
3. **Architecture** — React Flow diagram, but nodes appear one at a time as the AI narrates. Progressive reveal.
4. **Component** — Zoomed into one module. Files, functions, relationships. Code snippets inline.
5. **Code** — Full file viewer with line highlights. Diagram collapses to sidebar.

### Key changes
- New type: `VisualLayer` (1-5) in shared types, added to `SessionState`
- New components: `BookJacket.tsx`, `ConceptualFlow.tsx`, `CodeLayer.tsx`
- Modified: `DiagramPanel.tsx` switches renderer by layer
- Modified: `ArchitectureDiagram.tsx` gets progressive reveal (nodes fade in one by one)
- Modified: `manager.ts` emits `visual:layer_change` events tied to phases
- New voice commands: "zoom in", "zoom out", "show the big picture", "show the code"
- New prompt: project overview returns `conceptualSteps` for Layer 2

### Done when
- Each layer renders its own distinct visual
- Layer transitions are smooth (Framer Motion)
- AI narration drives layer changes automatically
- User can override with voice

---

## Feature 2: Smart Updates Mode (Phase B)

### What it is
Transform the weekly "Updates" review from a linear commit list into an intelligent, impact-ranked, thematic briefing.

### Key changes
- New prompt: `impact-ranking.ts` — scores areas by architectural impact, risk, novelty, breadth
- Modified clustering prompt: groups by theme ("Auth refactor") not directory ("src/auth/")
- Modified narrative prompt: leads with "why it matters" before "what changed"
- Quiet week handling: suggests unexplored areas from understanding model
- New component: `ArchitectureDiff.tsx` — highlights what changed in the diagram (green=new, red=removed)
- UI: areas sorted by impact, grouped by theme, risk badges visible

### Done when
- Areas ranked by impact, not line count
- Risk flags visible on area cards
- Quiet weeks suggest exploration
- Narration explains consequences, not just diffs

---

## Feature 3: Action Layer (Phase C)

### What it is
Three voice-triggered actions: draft GitHub issues, save notes, share explanations.

### GitHub Issues
- New skill: `create-issue.ts` — AI drafts title, body, labels from context
- New backend: `integrations/github.ts` — uses `gh` CLI for auth and issue creation
- New frontend: `IssueDraftPreview.tsx` — editable preview, confirm/cancel
- Voice: "create a ticket for this" → preview appears → "looks good" → created

### Save Notes
- Enhanced `annotate` skill — persists to DB with full context
- New frontend: `AnnotationsList.tsx` — shows notes for current repo, exportable
- Notes surface during revisits: "You left a note here last time..."

### Share Explanations
- New skill: `share.ts` — captures narration + code context
- Generates markdown snippet, copies to clipboard
- New frontend: `SharePanel.tsx` — preview + copy/download buttons

### Done when
- All three actions work via voice
- GitHub issues created via `gh` CLI with preview
- Notes persist and resurface
- Share copies markdown to clipboard

---

## Feature 4: Monday Morning Digest (Phase E)

### What it is
A weekly push notification summarizing what changed across all repos, with one-click walkthrough links.

### Key changes
- New: `digest/generator.ts` — analyzes all repos, ranks by impact, generates summary
- New: `digest/scheduler.ts` — uses `node-cron` for weekly scheduling
- New: `digest/email-sender.ts` — sends HTML email via `nodemailer`
- New: `digest/slack-sender.ts` — posts to Slack via webhook
- New DB table: `digest_history` — tracks sent digests
- Settings UI: enable/disable, schedule, delivery method, email/Slack config
- Deep links: `?repo=ID&mode=updates` opens the app directly into a walkthrough
- Quiet weeks: "Nothing changed, but explore the DB layer"
- Missed digest: on next startup, send it if it was missed

### Dependencies
- `node-cron` and `nodemailer` npm packages
- Requires Feature 2's impact ranking for intelligent summaries

### Done when
- Digest generated and delivered on schedule
- Email and Slack both work
- Deep links open the right walkthrough
- Quiet weeks still produce useful content

---

## Feature 5: Onboarding Mode (Phase D)

### What it is
A structured multi-day program for new team members, using progressive zoom layers.

### The program
- Day 1 (Layer 1-2): Project purpose and conceptual flow
- Day 2 (Layer 3): Architecture — how the pieces connect
- Day 3-4 (Layer 4): Key components deep dive
- Day 5 (Layer 5): Code patterns and conventions

### Key changes
- New types: `OnboardingProgram`, `OnboardingDay`, `OnboardingProgress`, `OnboardingReport`
- New DB tables: `onboarding_programs`, `onboarding_progress`
- New prompt: `onboarding.ts` — generates a 5-day program from codebase analysis
- New: `onboarding/generator.ts` — orchestrates program creation
- New: `onboarding/report-generator.ts` — completion report
- New frontend: `ProgramEditor.tsx` — customize the program (reorder, add/remove topics)
- New frontend: `CompletionReport.tsx` — visual report with understanding breakdown
- Modified: Lobby shows onboarding progress card for repos with active programs
- Modified: `manager.ts` gets `startOnboardingSession()` with day-specific flow
- Entry mode: "Full Walkthrough", "Updates", or "Start Onboarding"

### Done when
- Auto-generated 5-day program from any repo
- Each day uses the right visual layer
- Progress tracked across days with recap
- Customizable by team lead
- Completion report with understanding stats

---

## Shared Infrastructure

These changes cut across all features and should be done first:

1. `VisualLayer` type + `visualLayer` on `SessionState` (Feature 1, used by 5)
2. Extended `SkillName` union (Features 1, 3)
3. Extended `EntryMode` with `'onboarding'` (Feature 5)
4. New REST routes registered in `server.ts` (Features 3, 4, 5)
5. New DB tables in migration (Features 4, 5)
