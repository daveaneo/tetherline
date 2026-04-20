import type { Briefing } from '@tetherline/shared';

/**
 * Render a briefing as a shareable static HTML page. Meant for pasting into a
 * Slack message, emailing a teammate, or bookmarking for later review. Uses
 * inline styles so it renders anywhere without a stylesheet.
 */
export function renderBriefingHTML(briefing: Briefing, opts: { repoName?: string } = {}): string {
  const repoName = opts.repoName ?? 'Tetherline';
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const talkingPointsHtml = briefing.talkingPoints.length > 0
    ? `<ul style="padding-left:1.2em;margin-top:0.5em;color:#444">
         ${briefing.talkingPoints.map(p => `<li>${esc(p)}</li>`).join('')}
       </ul>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(briefing.title)} — ${esc(repoName)} briefing</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="max-width:720px;margin:3rem auto;padding:0 1.25rem;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;line-height:1.55">
  <div style="color:#888;font-size:13px;letter-spacing:0.04em;text-transform:uppercase">
    ${esc(repoName)} briefing · ${esc(briefing.layer)}
  </div>
  <h1 style="font-size:2em;margin:0.2em 0 0.8em;line-height:1.15">
    ${esc(briefing.title)}
  </h1>
  <p style="font-size:18px;color:#222">
    ${esc(briefing.opener)}
  </p>
  ${briefing.detail ? `<p style="color:#444;margin-top:1.2em">${esc(briefing.detail)}</p>` : ''}
  ${talkingPointsHtml ? `<h3 style="color:#666;font-size:14px;letter-spacing:0.04em;text-transform:uppercase;margin-top:2em">Talking points</h3>${talkingPointsHtml}` : ''}
  <hr style="margin:2.5em 0;border:none;border-top:1px solid #eee">
  <div style="color:#aaa;font-size:12px">
    Generated ${esc(briefing.cachedAt)} · est. ${briefing.estimatedSeconds}s spoken
    ${briefing.parent ? `· <a href="?id=${esc(briefing.parent)}" style="color:#888">up to ${esc(briefing.parent)}</a>` : ''}
  </div>
</body>
</html>`;
}
