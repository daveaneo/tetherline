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
import { useEffect, useMemo, useRef, useState } from 'react';
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

  // Active line range follows the currently-spoken stream chunk. The
  // backend emits each code-layer chunk with `range` + `filePath`; the
  // orchestrator sets `currentStreamChunk` while it's speaking. This
  // gives the user a live highlight that walks the file as Hermes
  // narrates — the missing R3 piece the audit flagged.
  const [ticketStatus, setTicketStatus] = useState<string | null>(null);
  const currentChunk = useSessionStore(s => s.currentStreamChunk);
  const activeRange = useMemo<[number, number] | null>(() => {
    if (!currentChunk?.range) return null;
    if (currentChunk.filePath && currentChunk.filePath !== filePath) return null;
    return currentChunk.range;
  }, [currentChunk, filePath]);

  // Auto-scroll the active range into view when it changes.
  const sourceRef = useRef<HTMLTableElement | null>(null);
  useEffect(() => {
    if (!activeRange) return;
    const el = sourceRef.current?.querySelector(`tr[data-line="${activeRange[0]}"]`);
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeRange]);

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => createTicketFromBriefing(briefing.briefingId, repoPath, briefing.title, setTicketStatus)}
            className="btn btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12 }}
            aria-label="Create a ticket from this briefing"
            data-testid="code-panel-create-ticket"
            disabled={ticketStatus === 'sending'}
          >
            {ticketStatus === 'sending' ? 'Sending…' : '+ Ticket'}
          </button>
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
        </div>
      </header>
      {ticketStatus && ticketStatus !== 'sending' && (
        <div
          data-testid="ticket-status"
          style={{
            padding: '8px 24px', fontSize: 11, fontFamily: 'var(--mono)',
            color: ticketStatus.startsWith('error')
              ? 'var(--sig-warn)'
              : ticketStatus.startsWith('dry')
                ? 'var(--cream-500)'
                : 'var(--sig-okay)',
            borderBottom: '1px solid oklch(1 0 0 / 0.05)',
          }}
        >
          {ticketStatus}
        </div>
      )}

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
          <table ref={sourceRef} cellPadding={0} cellSpacing={0} style={{ borderCollapse: 'collapse', width: '100%' }} data-testid="code-panel-source">
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

/** POST to /api/ticket/create with the current briefing as context.
 *  projectRef is best-effort: looks for a `git remote get-url origin`-
 *  shaped ref in the URL bar param, then falls back to the repo's
 *  basename. The dry-run provider accepts anything; the real GitHub
 *  adapter wants "owner/repo". */
async function createTicketFromBriefing(
  briefingId: string,
  repoPath: string,
  title: string,
  setStatus: (s: string) => void,
): Promise<void> {
  setStatus('sending');
  try {
    // projectRef heuristic: pull from the active repo's name. Real
    // implementation will want a settings field; for now just send
    // the repo path's basename and let the dry-run provider absorb it.
    const projectRef = repoPath.split('/').filter(Boolean).pop() ?? 'unknown/repo';
    const res = await fetch('/api/ticket/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, briefingId, projectRef, title }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(`error: ${body.error ?? res.status}`);
      return;
    }
    const { provider, url, externalId } = await res.json();
    if (provider === 'github-dryrun') {
      setStatus(`dry-run ticket created (${externalId}) — set TETHERLINE_TICKETS_LIVE=1 to write for real`);
    } else {
      setStatus(`created ${url}`);
    }
  } catch (err: any) {
    setStatus(`error: ${err.message}`);
  }
}
