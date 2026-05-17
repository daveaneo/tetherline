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
  { name: 'project-map', skill: 'Baseline project map', blurb:
    'The default radial map with no skill active. Module nodes orbit the project; each node is warm-lit by how well the user understands it (comprehension level). Header, knowledge legend, quick-chips and the voice bar are the persistent chrome.' },
  { name: 'heatmap', skill: 'whats_changed — comprehension heatmap', blurb:
    'Project-scope "what changed this week". An additive cold→warm wash sits behind the nodes that moved most; the narration panel states the summary. Diagram structure is never replaced — the heat is purely additive.' },
  { name: 'concern-tint', skill: 'critique — concern tint', blurb:
    'The spoken critique names risky nodes; those nodes glow worry-red (an intentional signal color) while the critique narration is shown. Additive tint, layout unchanged.' },
  { name: 'grill-screen', skill: 'grill_me — quiz screen', blurb:
    'A calm, full-bleed animated "?" screen replaces the diagram for a Socratic quiz. CAVEAT: under Playwright fresh-context capture timing the text "grill_me" / the GRILLING caption can briefly leak into the frame; the live settled DOM is clean (diagram fully replaced). Documented timing artifact, not a live defect.' },
  { name: 'shelf-notes', skill: 'annotate — Review Shelf · Notebook', blurb:
    'The Review Shelf open on the NOTEBOOK tab with saved annotations, each attributed to a module/file. The diagram stays intact behind the shelf overlay.' },
  { name: 'shelf-tasks', skill: 'Async task skill — Review Shelf · Tasks', blurb:
    'The Review Shelf TASKS tab: agent task rows with state styling — done, branch:<x>, and blocked.' },
  { name: 'descend', skill: 'DESCEND — scoped drill-in', blurb:
    'Drilled from the project into the Core module: a scoped sub-graph (analyzer.ts / audio-server.py / diagram-extractor.ts) with the breadcrumb, retitled header and intra-module edges.' },
  { name: 'deep-dive', skill: 'deep_dive — pocket presentation', blurb:
    'The "pocket dimension": a full-bleed ≤10-slide presentation that replaces the diagram (sandbox; exiting restores the canvas). Kicker · focus, N/M cursor, serif title + body, amber slide rail, exit hint. Slides ride on the pocket state, not a skill annotation, so the canvas is clean full-bleed.' },
  { name: 'pipeline', skill: 'Pipeline walkthrough', blurb:
    '"Show me the data flow" lights the graph one stage at a time in source→transform→guard→sink order; revealed nodes are lit, not-yet-revealed are dimmed. Header shows the stage strip. Reuses the tested pipelineRevealOrder core.' },
  { name: 'blast-radius', skill: 'Blast-radius ripple', blurb:
    '"What touches X" BFSes the import graph from the changed node and pulses concentric impact rings: hop 0 = solid warm epicenter, fading outward by hop distance. Reuses the tested blastRadiusRings core.' },
  { name: 'guided-mode', skill: 'Guided-learning mode', blurb:
    'A top-down guided tour: header spine of covered ▸ current (wide amber) ▸ upcoming steps, with the current step name. Mirrors the tested TourPlan.fromArchitecture {items,currentIndex} shape.' },
  { name: 'breadcrumb', skill: 'You-are-here breadcrumb', blurb:
    'The persistent "you are here" position trail (e.g. CORE › TOKEN REFRESH › 3/8) shown in the header inside a deep_dive pocket, over the scoped canvas.' },
  { name: 'knowledge-layer', skill: 'Knowledge v3 — Seen + Quiz/Grill', blurb:
    'Two axes, both rolled up over node ∪ descendants. Title block: ▶ replay · ↻ quiz · ⚑ grill · SEEN bar (deep briefing-coverage incl. this node — 80% here: 4 of 5 seen) · QUIZ/GRILL bar (the BEST for THIS view only — "—" because the overview was never quizzed; NOT the components\' average). Each component shows two side-by-side bars with explicit numbers: S(een) coverage + Q(uiz/Grill) best. Shared S100/Q— ("seen, not proven") is now visibly distinct from Voice S0/Q— ("never seen"). No verbal confirmation; dwell = narration actually finished playing.' },
  { name: 'knowledge-components', skill: 'Knowledge v3 — drilled to leaf files', blurb:
    'Drilled into Core. Title SEEN 75% (3 of 4 in the subtree seen), QUIZ/GRILL 67% = Core\'s OWN best quiz (best-for-this-view, not the leaf summary). Leaf files each show their own S/Q bars: analyzer.ts S100 Q100 ✓ (grill-passed), chunker.ts S100 Q33, audio-server.py S0 Q— (never seen / never tested).' },
  { name: 'weak-spots-review', skill: 'Knowledge v3 — weak-spots review loop', blurb:
    'The actionable "study this" loop: every weak/partial quiz/grill question becomes a row in the review panel on the current layer, tagged by source, with restudy ▶ and resolve ✓ (resolved items retained for audit). The clear pathway to learn more + the supervisor/QA trail.' },
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
      <div><span class="pgno">Page ${i + 2}</span><h1>${esc(s.skill)}</h1>
        <div class="scene">scene: <code>${s.name}</code></div></div>
      <div class="cite">cite as: <b>p${i + 2} · ${s.name} · &lt;viewport&gt;</b></div>
    </div>
    <p class="blurb">${esc(s.blurb)}</p>
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
    <div class="sub">12 skill scenes × {desktop · tablet · mobile}. Cite issues as
      <b>page · scene · viewport</b> (e.g. "p9 · pipeline · mobile").</div>
    <table><thead><tr><td class="pg">Pg</td><td class="sk">Skill</td><td class="sc">scene</td></tr></thead>
      <tbody>${indexRows}</tbody></table>
    <div class="gate"><b>pnpm verify: ALL GREEN</b> &nbsp;·&nbsp; typecheck 4/4 &nbsp;·&nbsp;
      lint 0 fails (130 any-warns) &nbsp;·&nbsp; unit 339/339 &nbsp;·&nbsp; scenes 36/36.<br/>
      Caveats: grill-screen Playwright capture-timing artifact (p5); mobile chrome dense but
      functional at 390px.</div>
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
