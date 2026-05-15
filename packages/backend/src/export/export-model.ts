/** Consolidated export (B17) — one model, N renderers.
 *
 * Per the plan: serialize what we already produce per area (SVG +
 * prose + files) into ONE ordered intermediate model; renderers
 * consume it. Scope (whole project vs a named subsection) is solved
 * UPSTREAM — it only decides which sections enter the model — so
 * every renderer is scope-agnostic for free. `share_explanation` is
 * just the smallest scope×format cell (one area → markdown); it
 * folds in, not a separate skill.
 *
 * Pure + deterministic. The route rewiring, the real HTML→PDF
 * (headless-chrome), and the video library are the integration
 * layer; video is an HONEST async-shaped stub here.
 */

export interface ExportSection {
  title: string;
  prose: string;
  files: string[];
  /** Inline SVG markup (already produced by the renderer). */
  svg?: string;
}

export interface ExportModel {
  projectName: string;
  sections: ExportSection[];
}

export type ExportFormat = 'markdown' | 'slides' | 'site' | 'pdf' | 'video';

/** Error thrown by not-yet-implemented renderers. Async-shaped: the
 *  caller treats export as a task, so this surfaces on the shelf as
 *  a failed artifact — never a silent hang or a fake success. */
export class NotImplementedError extends Error {
  constructor(public format: ExportFormat) {
    super(`Export format "${format}" is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** Build the model. `scope` undefined → whole project; a string →
 *  only sections whose title matches (case-insensitive contains).
 *  Filtering here keeps every renderer scope-agnostic. */
export function buildExportModel(
  projectName: string,
  sections: ExportSection[],
  scope?: string,
): ExportModel {
  const s = scope?.toLowerCase().trim();
  const filtered = s
    ? sections.filter(sec => sec.title.toLowerCase().includes(s))
    : sections;
  return { projectName, sections: filtered };
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(m: ExportModel): string {
  const out: string[] = [`# ${m.projectName}`, ''];
  for (const sec of m.sections) {
    out.push(`## ${sec.title}`, '', sec.prose, '');
    if (sec.files.length) {
      out.push('### Files', ...sec.files.map(f => `- \`${f}\``), '');
    }
  }
  return out.join('\n').trimEnd() + '\n';
}

/** A navigable multi-section SITE (NOT the slide deck): a sidebar of
 *  sections + content. Same content, different shell. */
export function renderSite(m: ExportModel): string {
  const nav = m.sections
    .map((s, i) => `<li><a href="#s${i}">${esc(s.title)}</a></li>`)
    .join('');
  const body = m.sections
    .map(
      (s, i) =>
        `<section id="s${i}"><h2>${esc(s.title)}</h2>${s.svg ?? ''}<p>${esc(
          s.prose,
        )}</p>${
          s.files.length
            ? `<ul class="files">${s.files.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
            : ''
        }</section>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(
    m.projectName,
  )}</title></head><body><nav><h1>${esc(
    m.projectName,
  )}</h1><ul>${nav}</ul></nav><main>${body}</main></body></html>`;
}

/** Format dispatcher. markdown/site are pure here; slides reuses the
 *  existing reveal generator (wired in the route); pdf is a post-step
 *  on site HTML (integration); video is the honest stub. */
export function exportAs(format: ExportFormat, m: ExportModel): string {
  switch (format) {
    case 'markdown':
      return renderMarkdown(m);
    case 'site':
      return renderSite(m);
    case 'slides':
      // NOT not-implemented: slides already works via the route's
      // existing reveal generator (which needs the session, not the
      // model). This pure dispatcher delegates rather than lies.
      throw new RouteDelegatedError('slides');
    case 'pdf':
    case 'video':
      // pdf → site→print (integration, not yet); video → real
      // library later. Honest stubs — never a fake success.
      throw new NotImplementedError(format);
  }
}

/** Thrown for a format that IS implemented but lives in the route
 *  layer (slides → reveal generator). Distinct from NotImplemented
 *  so callers/tests don't conflate "delegated" with "missing". */
export class RouteDelegatedError extends Error {
  constructor(public format: ExportFormat) {
    super(`Export format "${format}" is produced by the route layer, not the pure model`);
    this.name = 'RouteDelegatedError';
  }
}

/** `share_explanation` is the degenerate cell: one area → markdown. */
export function shareExplanation(section: ExportSection, projectName: string): string {
  return renderMarkdown({ projectName, sections: [section] });
}
