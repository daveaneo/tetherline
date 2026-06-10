/**
 * Copyable code/commands card. Renders whenever a spoken answer carried a
 * fenced code block — the backend lifts the fence OUT of the speech
 * (visual:artifact) and this card puts it ON the screen with a one-click
 * Copy button. The fix for: "when I ask for copy-paste you literally read
 * it out to me… there's like a one line that I can't interact with."
 *
 * One card at a time; a new artifact replaces it, × or a fresh session
 * clears it. Persists until then so the user copies on their own time.
 */
import { useEffect, useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ArtifactCard() {
  const artifact = useSessionStore(s => s.activeArtifact);
  const dismissArtifact = useSessionStore(s => s.dismissArtifact);
  const [copied, setCopied] = useState(false);

  // Reset the "Copied" feedback when a new artifact replaces the card.
  useEffect(() => { setCopied(false); }, [artifact?.id]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (!artifact) return null;

  const kindLabel = artifact.kind === 'commands' ? 'Commands' : 'Code';

  return (
    <aside
      className="absolute right-4 top-16 z-40 flex flex-col"
      data-testid="artifact-card"
      aria-label={`${kindLabel} ready to copy`}
      style={{
        width: 420,
        maxWidth: '88vw',
        maxHeight: '60vh',
        background: 'var(--ink-050)',
        border: '1px solid oklch(1 0 0 / 0.08)',
        borderRadius: 'var(--r-md, 10px)',
        boxShadow: '-12px 12px 40px oklch(0 0 0 / 0.35)',
      }}
    >
      <header
        className="flex items-center justify-between flex-none"
        style={{ padding: '12px 16px 10px', borderBottom: '1px solid oklch(1 0 0 / 0.05)' }}
      >
        <div className="flex items-baseline gap-2">
          <span
            className="font-mono"
            style={{ fontSize: 9.5, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)' }}
          >
            {kindLabel}
          </span>
          {artifact.language ? (
            <span className="font-mono" style={{ fontSize: 10.5, color: 'var(--amber-400)' }}>
              {artifact.language}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px 12px', fontSize: 12 }}
            data-testid="artifact-copy"
            aria-label="Copy to clipboard"
            onClick={() => { void copyToClipboard(artifact.body).then(ok => setCopied(ok)); }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
            data-testid="artifact-dismiss"
            aria-label="Dismiss"
            onClick={dismissArtifact}
          >
            ×
          </button>
        </div>
      </header>
      <pre
        className="font-mono overflow-auto flex-1 m-0"
        style={{
          padding: '14px 16px',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--cream-100)',
          whiteSpace: 'pre',
          userSelect: 'text',
        }}
      >
        <code>{artifact.body}</code>
      </pre>
    </aside>
  );
}
