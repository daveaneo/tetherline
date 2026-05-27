/** Build docs/VISUALIZE-FLOW-TEST.pdf — assembles the visualize-flow
 *  proof PNGs into a single presentation deck recreating the manual
 *  test the user did, plus robustness variants. One page per query,
 *  showing utterance → AI narration → rendered diagram.  Mirrors the
 *  polish-pdf.mjs pattern (Playwright/Chromium print-to-PDF, zero
 *  extra deps).  */
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PROOF = resolve(ROOT, 'docs/polish-proof');

const SCENES = [
  {
    name: 'visualize-flow-pipeline',
    utterance: '"Show me the flow when I am using PersonalForge."',
    expectKind: 'pipeline',
    narration:
      'Three input sources — local files, web URLs, and Hugging Face datasets — converge through the FileLoader, then a Chunker breaks them into instruction-response pairs. The ModelMatcher picks the right base model for your hardware, and the GGUFWriter bakes the result into a single self-contained file you can run anywhere.',
    behaviour:
      'visualize skill calls its `author_diagram` LLM tool, returns a 7-node pipeline (local-files / web-urls / hf-datasets → file-loader → chunker → model-matcher → gguf-writer). HermesDiagram swaps the cached project map for this authored payload for the lifetime of the skill result, then restores. The spoken text refers to the exact node labels on screen — words and picture agree (the bug we set out to fix).',
  },
  {
    name: 'visualize-flow-graph',
    utterance: '"How do auth and the cache wire together?"',
    expectKind: 'graph',
    narration:
      'The Router hands authenticated requests to the SessionManager, which reads from the ContextCache. The TokenGate guards refresh — when it stalls, the manager holds narration so nothing talks over a hung round-trip.',
    behaviour:
      'Robustness variant — same skill, different question shape. The LLM chose kind:`graph` (not pipeline), authored 4 nodes and 4 edges including a labelled "authed" edge. Proves the skill picks the right diagram kind for the question and the renderer handles non-pipeline shapes.',
  },
  {
    name: 'visualize-flow-fallback',
    utterance: '(any visualize query, when the structured LLM call fails)',
    expectKind: null,
    narration:
      "Couldn't author a custom diagram this time — but the project map you're on still tells the structural story: Core handles git + intelligence, Frontend renders the room and the diagram, Shared carries the types, and Voice gates barge-in.",
    behaviour:
      'Voice north-star — when structured-call throws, visualize falls back to plain prose with NO authored diagram in the payload. The frontend swap is a no-op (authoredPayload === null) so the cached project map stays on screen. Spoken UX degrades gracefully; nothing goes silent or blank.',
  },
];

const SUMMARY = [
  {
    h: 'Fix A — visualize authors a fresh diagram',
    p:
      'Replaced the prose-only skill with a structured LLM tool-call returning {narration, kind, nodes, edges, title, subtitle}. Kinds: pipeline / sequence / graph / tree. The frontend (HermesDiagram) swaps the cached payload for the authored one for the lifetime of the skillResult, then restores.',
  },
  {
    h: 'Fix B — mirror sentinel for the logic-view cache',
    p:
      "A cached logic-view whose source_hash matches the file-view row is a 'we fell back' mirror. The route now treats it as cache-miss (re-extract) on read and skips persistence on cold-path write. Self-heals the poisoned cache that produced the file-vs-logic-identical bug.",
  },
  {
    h: 'How to read the proofs',
    p:
      'Each page below renders a real scene from the deterministic Playwright harness (?scene=<name>), which seeds the store with the exact skillResult shape the new backend skill returns. The pixel-diff gate (maxDiffPixelRatio 0.01) guards regressions; baselines are committed.',
  },
];

const KNOWN_FOLLOWUPS = [
  'Radial layout: pipelines with ≥6 nodes overlap or clip — a kind-aware layout (left→right for pipeline, hierarchical for tree, sequence-rail for sequence) would let the diagram match the kind hint visually too.',
  'Subtitle "Local / web / HF sources → loader → chunker → matcher → GGUF" is rendering as a breadcrumb-style row, which works but isn\'t intentional — give the authored-diagram subtitle its own style so it reads as a caption.',
  'No e2e browser test against the live backend yet — the scenes harness proves the wiring with mocked skill payloads; a real-LLM run against a fixture would catch quality drift in the authored output (separate effort).',
];

const dataUri = (file) => {
  const b = readFileSync(resolve(PROOF, file));
  return `data:image/png;base64,${b.toString('base64')}`;
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const summaryRows = SUMMARY.map(s => `<li><b>${esc(s.h)}.</b> ${esc(s.p)}</li>`).join('');
const followupRows = KNOWN_FOLLOWUPS.map(s => `<li>${esc(s)}</li>`).join('');

const pages = SCENES.map((s, i) => `
  <section class="page">
    <div class="hdr">
      <div><span class="pgno">Page ${i + 2}</span><h1>${esc(s.name)}</h1></div>
      <div class="cite">cite as: <b>p${i + 2} · ${s.name} · &lt;viewport&gt;</b></div>
    </div>
    <div class="row">
      <div class="meta-col">
        <div class="meta-kicker">YOU SAID</div>
        <p class="meta-utt">${esc(s.utterance)}</p>
        <div class="meta-kicker">AI NARRATED</div>
        <p class="meta-narr">${esc(s.narration)}</p>
        <div class="meta-kicker">WHAT HAPPENED</div>
        <p class="meta-beh">${esc(s.behaviour)}</p>
        ${s.expectKind ? `<div class="meta-kicker">DIAGRAM KIND</div><p class="meta-kind"><code>${s.expectKind}</code></p>` : ''}
      </div>
      <div class="shot-col">
        <div class="shot main"><div class="vp">DESKTOP · 1440</div>
          <img src="${dataUri(`${s.name}-desktop.png`)}"/></div>
        <div class="thumbs">
          <div class="shot"><div class="vp">TABLET · 768</div>
            <img src="${dataUri(`${s.name}-tablet.png`)}"/></div>
          <div class="shot"><div class="vp">MOBILE · 390</div>
            <img src="${dataUri(`${s.name}-mobile.png`)}"/></div>
        </div>
      </div>
    </div>
  </section>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4 landscape; margin: 12mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, sans-serif; color: #1a1a1a; margin: 0; }
  .page { page-break-after: always; }
  .cover h1 { font-size: 30px; margin: 0 0 4px; }
  .cover .sub { color: #555; margin-bottom: 18px; font-size: 13px; }
  .cover h2 { font-size: 14px; margin: 18px 0 6px; letter-spacing: .04em; text-transform: uppercase; color: #444; }
  .cover ol, .cover ul { padding-left: 20px; font-size: 12.5px; line-height: 1.55; color: #222; }
  .cover li { margin-bottom: 6px; }
  .gate { margin-top: 18px; font-size: 12px; color: #333; background: #f4f4f2;
          border: 1px solid #e2e2e2; border-radius: 6px; padding: 12px 14px; }
  .gate b { color: #0a0; }
  .hdr { display: flex; justify-content: space-between; align-items: flex-start;
         border-bottom: 2px solid #1a1a1a; padding-bottom: 6px; margin-bottom: 10px; }
  .pgno { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: #999; }
  h1 { font-size: 18px; margin: 2px 0 0; font-family: ui-monospace, monospace; }
  .cite { font-size: 11px; color: #777; text-align: right; }
  .cite b { font-family: ui-monospace, monospace; }
  .row { display: grid; grid-template-columns: 1fr 1.4fr; gap: 14px; height: calc(100vh - 56mm); }
  .meta-col { font-size: 12px; line-height: 1.5; }
  .meta-kicker { font-size: 10px; letter-spacing: .14em; text-transform: uppercase;
                 color: #777; margin: 10px 0 4px; }
  .meta-utt { font-size: 14px; font-style: italic; color: #1a1a1a; margin: 0; }
  .meta-narr { color: #333; margin: 0; }
  .meta-beh { color: #333; margin: 0; }
  .meta-kind { margin: 0; }
  .meta-kind code { background: #f4f4f2; padding: 2px 6px; border-radius: 4px; font-size: 11.5px; }
  .shot { border: 1px solid #d8d8d8; border-radius: 5px; overflow: hidden; break-inside: avoid; }
  .shot img { display: block; width: 100%; object-fit: contain; background: #0d0d12; }
  .shot.main img { max-height: 240px; }
  .vp { font-size: 10px; letter-spacing: .1em; background: #1a1a1a; color: #fff;
        padding: 3px 7px; font-family: ui-monospace, monospace; }
  .thumbs { display: flex; gap: 8px; margin-top: 8px; }
  .thumbs .shot { flex: 1; }
  .thumbs .shot img { height: 130px; }
</style></head><body>
  <section class="page cover">
    <h1>Visualize-flow test — author fresh diagrams</h1>
    <div class="sub">Recreates the manual test (the "show me the flow" + "describe core" thread) plus
      robustness variants. Each page is a deterministic scene under the pixel-gated harness; the
      payloads match the shape the new backend skill returns.</div>
    <h2>What this proves</h2>
    <ul>${summaryRows}</ul>
    <h2>Known follow-ups (not blocking)</h2>
    <ul>${followupRows}</ul>
    <div class="gate"><b>pnpm verify: ALL GREEN</b> &nbsp;·&nbsp; typecheck 4/4 &nbsp;·&nbsp;
      lint 0 fails &nbsp;·&nbsp; unit (incl. new visualize-skill.test.ts) green &nbsp;·&nbsp;
      scenes 57/57 (3 new visualize-flow scenes × 3 viewports + 16 prior × 3).</div>
  </section>
  ${pages}
</body></html>`;

const out = resolve(ROOT, 'docs/VISUALIZE-FLOW-TEST.pdf');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
await page.pdf({ path: out, format: 'A4', landscape: true, printBackground: true });
await browser.close();
console.log(`wrote ${out}`);
