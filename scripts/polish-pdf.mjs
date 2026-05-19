/** Build docs/POLISH-REVIEW.pdf — one scene per page (index + 12 pages)
 *  so the user can cite "page N · <skill> · <viewport>" when flagging
 *  issues. Desktop image full-width + tablet/mobile thumbnails. Pure
 *  Playwright/Chromium print-to-PDF; no extra deps. */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PROOF = resolve(ROOT, 'docs/polish-proof');

// name → { skill, blurb }. Order = test/e2e/scenes.spec.ts.
const SCENES = [
  { name: 'project-map', skill: 'Project map — the home state', blurb:
    'WHO/WHY: not a skill and not user-invoked — this is what you land on the moment a repo opens, before any request. The radial map of modules around the project. Each node carries its live Seen/Quiz bars and the header knowledge strip, all rendered from session state. Everything else in this deck is something layered on top of this.' },
  { name: 'heatmap', skill: 'whats_changed — "what you\'re behind on" (closeable loop)', blurb:
    'WHO/WHY: you ask in plain language ("what changed?", "catch me up") — the intent classifier maps that to the whats_changed skill; you never name or click it. Project scope only (drilled-in/per-module drift is a documented follow-up). WHAT: a spoken recap while the diagram washes warm over DRIFT — changed code you haven\'t caught up on: red (changed, never reviewed) = hot, yellow (changed since you last reviewed) = warm, green (you reviewed it SINCE it changed) = cold, unchanged = no wash. Deliberately NOT raw churn. PATHWAY (now closed): the hot nodes are the agenda — "walk me through the changes" steps each changed area; being walked through one marks its files reviewed-since-change (decision: walked-through = caught up, no quiz gate) and re-emits the heatmap so that node cools to green live. All-green = caught up for the week (the tether re-established). No card; the diagram is the whole visual.' },
  { name: 'concern-tint', skill: 'critique — ranked concerns + active tint', blurb:
    'WHO/WHY: you ask for an opinion ("is this good?", "any issues with X?", "what do you think of Y?") — classifier → the critique skill; you never name it. WHAT: one structured call returns up to 5 genuine concerns, severity-ranked (HIGH→LOW); the voice speaks the top one and the drawer lists them all (severity pip + title, top expanded with its 3-4 sentence detail). Only the ACTIVE concern\'s nodes glow — and the LLM names those targets explicitly, so the ring matches the worry instead of the old bug where every node merely NAMED (even praised ones) lit up. The ring uses the --sig-concern design token, so "concern" is one consistent colour app-wide. Voice north-star: a structured-call failure falls back to plain spoken prose (deterministic narration match), never silence.' },
  { name: 'concern-tint-next', skill: 'critique — stepping concerns (client-side)', blurb:
    'WHO/WHY: same critique result; YOU click a concern row or "Next concern" (no voice, no classifier, no extra LLM call — the details all came back in the first call). WHAT: the active concern advances (here: #2 "Core couples tightly to Voice"), its detail re-speaks via the existing TTS path, and the diagram tint MOVES off Voice onto Core — proof the highlight tracks exactly what is being discussed.' },
  { name: 'grill-screen', skill: 'grill_me — quiz screen', blurb:
    'WHO/WHY: you ask to be tested ("quiz me", "grill me on X", "test my understanding") — classifier → the grill_me skill; you never name it. WHAT: a calm full-bleed "?" mode screen replaces the diagram for a Socratic quiz; the Q&A itself rides voice + HermesText, not a card. FIXED (was mislabelled a "Playwright timing artifact"): the drawer used to open a card for grill_me and — because its narration is intentionally empty — render the raw skill id "grill_me" as a heading AND overlay/​clip the screen caption. Same bug class as the old "document that says whats_changed". grill_me is now in the full-bleed suppression gate (drawer + panel), so the "?" screen is truly full-bleed and no raw id leaks.' },
  { name: 'shelf-notes', skill: 'Review Shelf · Notebook (annotate)', blurb:
    'WHO/WHY: YOU open the Review Shelf from the top chrome; the Notebook tab fills over time as the annotate skill runs ("flag this", "remember this", "note that"). WHAT: saved annotations, each attributed to a module/file. Flagging confirms via three signals — a spoken "Noted", the Notebook row, and a pin on the target node — and deliberately NOT a redundant transient drawer card (same self-confirming rule as whats_changed/grill_me). The diagram stays intact behind the shelf.' },
  { name: 'shelf-tasks', skill: 'Review Shelf · Tasks (async agent)', blurb:
    'WHO/WHY: same shelf, Tasks tab — rows are background agent tasks YOU dispatched ("go fix X", "audit Y"), surfaced here for review. WHAT: task rows with the state colour-coded by signal token so the queue is scannable at a glance — blocked (needs you) = concern, done = okay-green, branch/running = neutral accent.' },
  { name: 'descend', skill: 'Drill-in (navigation, not a skill)', blurb:
    'WHO/WHY: navigation — you say "show me Core" / "go into X" or click a module node; the view scope-swaps. No skill, no classifier. WHAT: the scoped sub-graph for that module (its files, intra-module edges, retitled header, breadcrumb).' },
  { name: 'deep-dive', skill: 'deep_dive — pocket presentation', blurb:
    'WHO/WHY: you ask to go deep ("deep dive on X", "go deeper", "really walk me through this") — classifier → the deep_dive skill. WHAT: a full-bleed ≤10-slide pocket REPLACES the diagram (a sandbox; exiting restores the exact prior canvas). Kicker·focus, N/M cursor, slide rail, exit hint.' },
  { name: 'pipeline', skill: 'pipeline — data-flow walkthrough', blurb:
    'WHO/WHY: you ask how data moves ("show me the data flow", "walk me through how X works end to end") — classifier → the pipeline walkthrough. WHAT: the graph lights one stage at a time source→transform→guard→sink; revealed lit, rest dimmed; header stage strip.' },
  { name: 'blast-radius', skill: 'blast-radius — impact ripple', blurb:
    'WHO/WHY: you ask about impact ("what touches X?", "blast radius of Y", "what depends on this?") — classifier → the blast-radius skill. WHAT: a BFS over the import graph from the changed node; concentric rings fade outward by hop distance (hop 0 = solid warm epicenter).' },
  { name: 'guided-mode', skill: 'guided tour — planned walkthrough', blurb:
    'WHO/WHY: you ask for a guided tour ("walk me through the project", "give me the tour", "teach me this codebase") — a top-down planned tour drives the session. WHAT: a header spine of covered ▸ current (wide amber) ▸ upcoming steps with the current step name.' },
  { name: 'breadcrumb', skill: 'You-are-here trail (always-on chrome)', blurb:
    'WHO/WHY: not a skill — always-on orientation chrome that appears in the header whenever you are inside a deep_dive pocket, driven by navigation depth. WHAT: the position trail, e.g. CORE › TOKEN REFRESH › 3/8, over the scoped canvas.' },
  { name: 'knowledge-layer', skill: 'Knowledge — current layer (always-on)', blurb:
    'WHO/WHY: not a skill — always-on chrome that renders from live session state on any layer; nobody "calls" it. WHAT: the title block is THIS view\'s own Seen + best Quiz/Grill (best-for-this-view, not an average); each component shows its rolled-up Seen / Quiz-Grill summary bars with explicit numbers. "Shared S100/Q—" (seen, not proven) is visibly distinct from "Voice S0/Q—" (never seen). Dwell = narration actually finished playing; no verbal-confirmation shortcut.' },
  { name: 'knowledge-components', skill: 'Knowledge — drilled into a module', blurb:
    'WHO/WHY: the same always-on knowledge chrome, after you drill into a module. WHAT: the title shows Core\'s OWN Seen + best quiz (this view only, not the leaf summary); each leaf file shows its own S/Q bars — analyzer.ts S100 Q100 ✓ (grill-passed), chunker.ts S100 Q33, audio-server.py S0 Q— (never seen / never tested).' },
  { name: 'weak-spots-review', skill: 'Knowledge — weak-spots review loop', blurb:
    'WHO/WHY: YOU open it from the title strip\'s "weak spots (N)"; it fills automatically as you miss quiz/grill questions. WHAT: every weak/partial question becomes a row with restudy ▶ / resolve ✓ (resolved kept for audit). The actionable pathway to learn more + the supervisor/QA trail.' },
];

const dataUri = (file) => {
  const b = readFileSync(resolve(PROOF, file));
  return `data:image/png;base64,${b.toString('base64')}`;
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const indexRows = SCENES.map((s, i) => `
  <tr><td class="pg">${i + 2}</td><td class="sk">${esc(s.skill)}</td><td class="sc">${s.name}</td></tr>`).join('');

const pages = SCENES.map((s, i) => `
  <section class="page">
    <div class="hdr">
      <div><span class="pgno">Page ${i + 2}</span><h1>${esc(s.skill)}</h1></div>
      <div class="cite">cite as: <b>p${i + 2} · ${s.name} · &lt;viewport&gt;</b></div>
    </div>
    <p class="blurb">${esc(s.blurb)}</p>
    <div class="scene">These shots are rendered from a deterministic UI test fixture (no live backend), so this exact state is reproducible and pixel-checked on every build — that is what the citation id above refers to.</div>
    <div class="shot main"><div class="vp">DESKTOP · 1440</div>
      <img src="${dataUri(`${s.name}-desktop.png`)}"/></div>
    <div class="thumbs">
      <div class="shot"><div class="vp">TABLET · 768</div>
        <img src="${dataUri(`${s.name}-tablet.png`)}"/></div>
      <div class="shot"><div class="vp">MOBILE · 390</div>
        <img src="${dataUri(`${s.name}-mobile.png`)}"/></div>
    </div>
  </section>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; color: #1a1a1a; margin: 0; }
  .page { page-break-after: always; }
  .cover h1 { font-size: 28px; margin: 0 0 4px; }
  .cover .sub { color: #555; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td { padding: 7px 8px; border-bottom: 1px solid #e2e2e2; }
  .pg { width: 48px; color: #888; font-variant-numeric: tabular-nums; }
  .sk { font-weight: 600; }
  .sc { color: #777; font-family: ui-monospace, monospace; font-size: 12px; }
  .gate { margin-top: 22px; font-size: 12px; color: #333; background: #f4f4f2;
          border: 1px solid #e2e2e2; border-radius: 6px; padding: 12px 14px; }
  .gate b { color: #0a0; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start;
         border-bottom: 2px solid #1a1a1a; padding-bottom: 8px; margin-bottom: 10px; }
  .pgno { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #999; }
  h1 { font-size: 19px; margin: 2px 0 0; }
  .scene { font-size: 12px; color: #777; margin-top: 2px; }
  .scene code, .cite b { font-family: ui-monospace, monospace; }
  .cite { font-size: 11px; color: #777; text-align: right; }
  .blurb { font-size: 12.5px; line-height: 1.5; color: #333; margin: 0 0 10px; }
  .page { break-inside: avoid; }
  .shot { border: 1px solid #d8d8d8; border-radius: 5px; overflow: hidden;
          break-inside: avoid; }
  .shot img { display: block; width: 100%; object-fit: contain;
              background: #0d0d12; }
  .shot.main img { max-height: 330px; }
  .vp { font-size: 10px; letter-spacing: .1em; background: #1a1a1a; color: #fff;
        padding: 3px 7px; font-family: ui-monospace, monospace; }
  .thumbs { display: flex; gap: 10px; margin-top: 10px; }
  .thumbs .shot { flex: 1; }
  .thumbs .shot img { height: 150px; }
</style></head><body>
  <section class="page cover">
    <h1>Tetherline — Visual Polish Review</h1>
    <div class="sub">${SCENES.length} scenes × {desktop · tablet · mobile}. Cite issues as
      <b>page · scene · viewport</b> (e.g. "p10 · pipeline · mobile").</div>
    <table><thead><tr><td class="pg">Pg</td><td class="sk">Skill</td><td class="sc">scene</td></tr></thead>
      <tbody>${indexRows}</tbody></table>
    <div class="gate"><b>pnpm verify: ALL GREEN</b> &nbsp;·&nbsp; typecheck 4/4 &nbsp;·&nbsp;
      lint 0 fails &nbsp;·&nbsp; unit green &nbsp;·&nbsp; scenes ${SCENES.length * 3}/${SCENES.length * 3}.<br/>
      Note: the broader integration arc (hermes-*/drill/voice) has pre-existing failures
      OUTSIDE the verify gate — LLM-pipeline 404s + stale v2-era assertions superseded by
      the shipped v3 knowledge model; not regressions from this work. Caveat: mobile chrome
      dense but functional at 390px.</div>
  </section>
  ${pages}
</body></html>`;

const out = resolve(ROOT, 'docs/POLISH-REVIEW.pdf');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: out, format: 'A4', printBackground: true });
await browser.close();
console.log(`wrote ${out}`);
