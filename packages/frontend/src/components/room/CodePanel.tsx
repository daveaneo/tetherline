/**
 * CodePanel — opens when a code-layer briefing is active. Renders the
 * file's content read-only, with the active chunk's line range
 * highlighted as Hermes walks through it.
 *
 * Voice and chip controls (UP, "go back", hold-to-talk) all keep
 * working — the panel is purely presentation. Closing the panel is
 * either UP-arrow (pops the navigator off the code briefing) or click
 * the close button.
 *
 * The file body is fetched once when the panel mounts; subsequent
 * highlight changes are pure re-render. Files >200KB are rejected by
 * the backend; we render an empty-state with the file path.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';
import { sendEvent } from '../../lib/ws-client.js';
import { API_PREFIX } from '@tetherline/shared';

interface FileFetch {
  path: string;
  content: string;
  loading: boolean;
  error: string | null;
}

export function CodePanel() {
  const briefing = useSessionStore(s => s.currentBriefing);
  const repoPath = useSessionStore(s => s.activeRepoPath);
  const [file, setFile] = useState<FileFetch | null>(null);

  const isCodeBriefing = briefing?.layer === 'code';
  // Pull the file path from the briefing id format `code/<filePath>:<symbol?>`.
  const filePath = useMemo(() => {
    if (!isCodeBriefing || !briefing) return null;
    const stripped = briefing.briefingId.replace(/^code\//, '');
    const colonIdx = stripped.lastIndexOf(':');
    if (colonIdx === -1) return stripped;
    // If everything after `:` is a digit-range (e.g. ":42-58") we'd
    // strip it too — for now we only have file:symbol form.
    return stripped.slice(0, colonIdx);
  }, [briefing, isCodeBriefing]);

  // Active line range: derived from the briefing's first talking point's
  // chunk reference. Composer doesn't expose chunks in the WS payload
  // directly, so we infer from the talking point text. For a richer
  // experience, the WS payload could carry chunks explicitly — punted
  // for now; the panel still renders the whole file with a soft-focus
  // hint at the top.
  const [activeRange] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!isCodeBriefing || !filePath || !repoPath) {
      setFile(null);
      return;
    }
    let cancelled = false;
    setFile({ path: filePath, content: '', loading: true, error: null });
    const url = `${API_PREFIX}/repos/file?repoPath=${encodeURIComponent(repoPath)}&path=${encodeURIComponent(filePath)}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ path: string; content: string }>;
      })
      .then((j) => {
        if (cancelled) return;
        setFile({ path: filePath, content: j.content, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setFile({ path: filePath, content: '', loading: false, error: err.message });
      });
    return () => { cancelled = true; };
  }, [isCodeBriefing, filePath, repoPath]);

  if (!isCodeBriefing || !briefing) return null;

  return (
    <aside
      className="absolute top-0 right-0 bottom-0 z-40 flex flex-col"
      data-testid="code-panel"
      style={{
        width: 560,
        maxWidth: '92vw',
        background: 'var(--ink-050)',
        borderLeft: '1px solid oklch(1 0 0 / 0.06)',
        boxShadow: '-12px 0 40px oklch(0 0 0 / 0.3)',
      }}
      aria-label="Code panel"
    >
      <header
        className="flex items-baseline justify-between flex-none"
        style={{ padding: '20px 24px 12px', borderBottom: '1px solid oklch(1 0 0 / 0.05)' }}
      >
        <div>
          <div
            className="font-mono"
            style={{ fontSize: 9.5, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)' }}
          >
            Code walk
          </div>
          <div
            className="font-mono mt-1"
            style={{ fontSize: 13, color: 'var(--amber-400)' }}
          >
            {briefing.title}
          </div>
          <div
            className="font-mono mt-1"
            style={{ fontSize: 10.5, color: 'var(--cream-500)', opacity: 0.7 }}
          >
            {filePath}
          </div>
        </div>
        <button
          type="button"
          onClick={() => sendEvent({ type: 'command:level_up' })}
          className="btn btn-ghost"
          style={{ padding: '6px 10px', fontSize: 12 }}
          aria-label="Close code panel and go up one level"
          data-testid="code-panel-close"
        >
          ↑ Up
        </button>
      </header>

      <div
        className="flex-1 overflow-auto font-mono"
        style={{ padding: '12px 0', fontSize: 11.5, lineHeight: 1.6, color: 'var(--cream-100)' }}
      >
        {file?.loading && (
          <div style={{ padding: '0 24px', color: 'var(--cream-500)' }}>Loading…</div>
        )}
        {file?.error && (
          <div style={{ padding: '0 24px', color: 'var(--sig-warn)' }}>
            Couldn't load file: {file.error}
          </div>
        )}
        {file?.content && (
          <table cellPadding={0} cellSpacing={0} style={{ borderCollapse: 'collapse', width: '100%' }} data-testid="code-panel-source">
            <tbody>
              {file.content.split('\n').map((line, idx) => {
                const lineNum = idx + 1;
                const inActive = activeRange && lineNum >= activeRange[0] && lineNum <= activeRange[1];
                return (
                  <tr key={lineNum} data-line={lineNum}>
                    <td
                      style={{
                        textAlign: 'right',
                        paddingLeft: 16,
                        paddingRight: 12,
                        color: 'var(--cream-500)',
                        opacity: 0.5,
                        userSelect: 'none',
                        verticalAlign: 'top',
                      }}
                    >
                      {lineNum}
                    </td>
                    <td
                      style={{
                        whiteSpace: 'pre',
                        paddingRight: 16,
                        background: inActive ? 'color-mix(in oklch, var(--amber-500) 14%, transparent)' : 'transparent',
                      }}
                    >
                      {line || ' '}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}
