import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../../lib/api-client.js';
import { sendEvent } from '../../lib/ws-client.js';
import { useAudioStore } from '../../state/audio-store.js';
import { useSessionStore } from '../../state/session-store.js';
import type { EntryMode } from '@tetherline/shared';

interface Repo {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastReviewedAt: string | null;
  totalSessions: number;
  understandingPct: number;
  newCommits?: number;
  contributors?: string[];
}

interface RecentSession {
  id: string;
  repoName: string;
  startedAt: string;
  totalAreas?: number;
  totalCommits?: number;
  summary?: string;
}

const WINDOWS = [
  { days: 1,  label: '24', unit: 'hours' },
  { days: 7,  label: '7',  unit: 'days' },
  { days: 14, label: '14', unit: 'days' },
  { days: 30, label: '30', unit: 'days' },
];

export function Lobby() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [sessions, setSessions] = useState<RecentSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(7);
  const [keyStatus, setKeyStatus] = useState<{ hasAnthropicKey: boolean; hasOpenaiKey: boolean } | null>(null);
  const [entryModeRepo, setEntryModeRepo] = useState<Repo | null>(null);

  const loadRepos = useCallback(async () => {
    try {
      const data = await api.listRepos();
      setRepos(data.repos);
      const enriched = await Promise.all(
        data.repos.map(async (repo: Repo) => {
          try {
            const details = await api.getRepo(repo.id);
            return { ...repo, newCommits: details.newCommits, contributors: details.contributors };
          } catch {
            return repo;
          }
        })
      );
      setRepos(enriched);
      if (enriched[0] && !selectedRepoId) setSelectedRepoId(enriched[0].id);
    } catch (err) {
      console.error('Failed to load repos:', err);
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId]);

  useEffect(() => { loadRepos(); }, [loadRepos]);

  useEffect(() => {
    api.listSessions()
      .then(data => setSessions(data.sessions.slice(0, 10)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    api.health()
      .then(data => setKeyStatus({ hasAnthropicKey: data.hasAnthropicKey, hasOpenaiKey: data.hasOpenaiKey }))
      .catch(() => {});
  }, []);

  const selectedRepo = useMemo(
    () => repos.find(r => r.id === selectedRepoId) ?? null,
    [repos, selectedRepoId]
  );

  const lastSessionForSelected = useMemo(
    () => sessions.find(s => s.repoName === selectedRepo?.name),
    [sessions, selectedRepo]
  );

  const handlePickRepo = (repo: Repo) => {
    setSelectedRepoId(repo.id);
  };

  const handleBegin = () => {
    if (!selectedRepo) return;
    // Mic is intentionally NOT auto-started anymore. The user's audit
    // surfaced that ambient sound (or the AI's own speakers) bleeding
    // into a hot mic was the root of "AI interrupts itself." Mic now
    // starts off; user enables it explicitly via the chrome toolbar
    // toggle, or holds space for one-shot PTT.
    setEntryModeRepo(selectedRepo);
  };

  // Double-fire guard: button click + the dialog's voice-select effect can
  // both land in the same tick. One session:start per dialog open; reset
  // when a new repo dialog opens. (The backend has its own idempotency
  // guard as the backstop.)
  const startSentRef = useRef(false);
  useEffect(() => { if (entryModeRepo) startSentRef.current = false; }, [entryModeRepo]);
  const handleStartSession = useCallback((mode: EntryMode) => {
    const target = entryModeRepo;
    if (!target || startSentRef.current) return;
    startSentRef.current = true;
    // For full project review we want the WHOLE git history, not just
    // the recent window. The "updates" mode is what uses `windowDays`.
    const sinceDays = mode === 'full_walkthrough' || mode === 'onboarding' || mode === 'explore'
      ? 3650 // ~10 years; effectively all history
      : windowDays;
    useSessionStore.setState({ activeRepoPath: target.path, entryMode: mode });
    sendEvent({ type: 'session:start', payload: { repoPath: target.path, sinceDays, entryMode: mode } });
    setEntryModeRepo(null);
  }, [entryModeRepo, windowDays]);

  const handleResumeSession = (sessionId: string) => {
    sendEvent({ type: 'session:resume', payload: { sessionId } });
  };

  // Enter = Begin session (the button advertises ⏎ — it has to be true).
  // Inert while a dialog is open or focus is in a text field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if (showAddDialog || entryModeRepo) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const repo = repos.find(r => r.id === selectedRepoId);
      if (repo) setEntryModeRepo(repo);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAddDialog, entryModeRepo, repos, selectedRepoId]);

  if (loading) {
    return (
      <div className="lobby" aria-busy="true">
        <div className="lobby-kicker">
          <span className="dot" />
          <span>Tetherline · Weekly briefing</span>
        </div>
        <h1 className="lobby-hero">
          Let&apos;s see what <em>changed</em> this week.
        </h1>
        <div className="lobby-grid">
          <div className="lobby-card">
            <div className="kicker mb-5">Repositories</div>
            {[0, 1, 2].map(i => (
              <div key={i} className="skeleton mb-2" style={{ height: 64, opacity: 1 - i * 0.25 }} />
            ))}
          </div>
          <div className="prev-card">
            <div className="skeleton" style={{ height: 18, width: 110 }} />
            <div className="skeleton mt-4" style={{ height: 34, width: '85%' }} />
            <div className="skeleton mt-2" style={{ height: 34, width: '60%' }} />
            <div className="skeleton mt-6" style={{ height: 14, width: '70%' }} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="lobby">
      {keyStatus && !keyStatus.hasAnthropicKey && (
        <div
          className="mb-6 p-4 rounded-xl"
          style={{
            border: '1px solid color-mix(in oklch, var(--amber-500) 30%, transparent)',
            background: 'color-mix(in oklch, var(--amber-500) 8%, transparent)',
          }}
        >
          <p className="text-sm" style={{ color: 'var(--amber-200)' }}>
            No Anthropic API key detected. AI narration and analysis won&apos;t work.
            Add <code className="font-mono text-xs px-1 rounded" style={{ background: 'var(--ink-000)' }}>ANTHROPIC_API_KEY</code> to your <code className="font-mono">.env</code> file.
          </p>
        </div>
      )}

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="lobby-kicker"
      >
        <span className="dot" />
        <span>Tetherline · Weekly briefing</span>
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
        className="lobby-hero"
      >
        Let&apos;s see what <em>changed</em> this week.
      </motion.h1>
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.35 }}
        className="lobby-sub"
      >
        Stay tethered to your codebase. Each week, the AI walks you through what changed — voice-led, interruptible, with a heatmap of what you&apos;ve actually absorbed.
      </motion.p>

      {repos.length === 0 ? (
        <div className="lobby-card mt-12 text-center" style={{ padding: 64 }}>
          <h2 className="font-serif text-3xl" style={{ color: 'var(--cream-900)' }}>No repositories yet</h2>
          <p className="mt-3" style={{ color: 'var(--cream-500)' }}>
            Add a git repository to start your first review session.
          </p>
          <button
            type="button"
            onClick={() => setShowAddDialog(true)}
            className="btn btn-primary btn-xl mt-8"
          >
            Add your first repository
          </button>
        </div>
      ) : (
        <>
          <div className="lobby-grid">
            <div className="lobby-card">
              <div className="ck">
                <div className="kicker">Repositories</div>
                <button
                  type="button"
                  onClick={() => setShowAddDialog(true)}
                  className="btn btn-ghost"
                  style={{ padding: '8px 14px', fontSize: 12.5 }}
                >
                  + Add repository
                </button>
              </div>
              <div className="space-y-1">
                {repos.map((repo, i) => (
                  <motion.button
                    key={repo.id}
                    type="button"
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    onClick={() => handlePickRepo(repo)}
                    className={`repo-row ${selectedRepoId === repo.id ? 'is-active' : ''}`}
                  >
                    <div className="repo-glyph">{glyph(repo.name)}</div>
                    <div className="repo-meta">
                      <div className="n">{repo.name}</div>
                      <div className="b">{repo.path}</div>
                      <div className="und-bar" style={{ width: 160, marginTop: 6 }}>
                        <div className="fill" style={{ width: `${Math.max(2, Math.round(repo.understandingPct))}%` }} />
                      </div>
                    </div>
                    <div className="repo-stat">
                      {repo.newCommits != null && repo.newCommits > 0 ? (
                        <span style={{ color: 'var(--amber-400)' }}>+{repo.newCommits}</span>
                      ) : repo.lastReviewedAt ? (
                        <span>{formatTimeAgo(repo.lastReviewedAt)}</span>
                      ) : (
                        <span>new</span>
                      )}
                    </div>
                  </motion.button>
                ))}
              </div>

              <div className="kicker mt-8 mb-3">Review window</div>
              <div className="window-picker">
                {WINDOWS.map(w => (
                  <button
                    key={w.days}
                    type="button"
                    onClick={() => setWindowDays(w.days)}
                    className={`window-pill ${windowDays === w.days ? 'is-active' : ''}`}
                  >
                    <div className="n">{w.label}</div>
                    <div className="u">{w.unit}</div>
                  </button>
                ))}
              </div>
            </div>

            {lastSessionForSelected ? (() => {
              // Headline = first sentence; body = the REST of the summary.
              // It used to render the identical text twice (32px serif,
              // then verbatim again at 14.5px) — a full screen of card
              // height saying one thing.
              const summary = lastSessionForSelected.summary?.trim() ?? '';
              const headline = summary.split('.')[0] || lastSessionForSelected.repoName;
              const rest = summary.length > headline.length + 1
                ? summary.slice(headline.length + 1).trim()
                : '';
              return (
                <div className="prev-card">
                  <div className="prev-eyebrow">Previously on</div>
                  <div className="prev-title">{headline}</div>
                  <div className="prev-meta-row">
                    {lastSessionForSelected.totalAreas != null && (
                      <span><b>{lastSessionForSelected.totalAreas}</b>areas</span>
                    )}
                    {lastSessionForSelected.totalCommits != null && (
                      <span><b>{lastSessionForSelected.totalCommits}</b>commits</span>
                    )}
                    <span><b>{formatTimeAgo(lastSessionForSelected.startedAt)}</b></span>
                  </div>
                  {rest && (
                    <p className="prev-body">{rest}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => handleResumeSession(lastSessionForSelected.id)}
                    className="btn btn-ghost mt-5"
                    style={{ padding: '8px 14px', fontSize: 12.5 }}
                  >
                    Resume this session
                  </button>
                </div>
              );
            })() : (
              <div className="prev-card">
                <div className="prev-eyebrow">First visit</div>
                <div className="prev-title">
                  Pick a repo. We&apos;ll take it from there.
                </div>
                <p className="prev-body">
                  Your first session will build a baseline — the AI skims the repo, maps the architecture, and hands you a guided tour. After that, every weekly session builds on what you&apos;ve already seen.
                </p>
              </div>
            )}
          </div>

          {selectedRepo && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.5 }}
              className="mt-8 flex items-center justify-between gap-6"
              style={{
                // Sticky: the primary CTA used to live below the fold at
                // 1440×900 — now it rides the bottom edge until its
                // natural position scrolls into view.
                position: 'sticky',
                bottom: 16,
                zIndex: 10,
                padding: '18px 28px',
                background: 'color-mix(in oklch, var(--ink-100) 92%, transparent)',
                backdropFilter: 'blur(16px)',
                border: '1px solid oklch(1 0 0 / 0.08)',
                borderRadius: 'var(--r-xl)',
                boxShadow: 'var(--shadow-2)',
              }}
            >
              <div>
                <div className="font-mono" style={{ fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--amber-400)' }}>
                  Ready · last {windowDays} day{windowDays === 1 ? '' : 's'}
                </div>
                <div className="mt-2 font-serif" style={{ fontSize: 28, color: 'var(--cream-900)', letterSpacing: '-0.018em', fontStyle: 'italic', fontWeight: 300 }}>
                  {selectedRepo.name}
                </div>
              </div>
              <button
                type="button"
                onClick={handleBegin}
                className="btn btn-primary btn-xl"
              >
                Begin session
                <span className="font-mono" style={{ fontSize: 11, opacity: 0.7 }}>⏎</span>
              </button>
            </motion.div>
          )}

          {sessions.length > 0 && (() => {
            const visible = sessions.filter(s => (s.totalCommits ?? 0) > 0 || (s.totalAreas ?? 0) > 0).slice(0, 5);
            if (visible.length === 0) return null;
            return (
              <div className="mt-16">
                <div className="flex items-center justify-between mb-4">
                  <div className="kicker">Recent sessions</div>
                  {sessions.length > 5 && (
                    <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--cream-500)' }}>
                      {visible.length} of {sessions.length}
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {visible.map((session, i) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => handleResumeSession(session.id)}
                      className="w-full flex items-center gap-4 text-left transition-colors"
                      style={{
                        padding: '14px 18px',
                        borderLeft: i === 0
                          ? '2px solid var(--amber-500)'
                          : '2px solid color-mix(in oklch, var(--amber-500) 25%, transparent)',
                        background: i === 0 ? 'oklch(1 0 0 / 0.025)' : 'oklch(1 0 0 / 0.012)',
                        borderRadius: '0 var(--r-md) var(--r-md) 0',
                      }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-serif" style={{ fontSize: 17, color: 'var(--cream-900)', letterSpacing: '-0.008em' }}>
                          {session.repoName}
                        </div>
                        <div className="font-mono mt-1" style={{ fontSize: 11, color: 'var(--cream-500)', letterSpacing: '0.02em' }}>
                          {session.totalAreas != null && session.totalAreas > 0 && `${session.totalAreas} areas · `}
                          {session.totalCommits != null && session.totalCommits > 0 && `${session.totalCommits} commits · `}
                          {formatTimeAgo(session.startedAt)}
                        </div>
                      </div>
                      {session.summary && (
                        <span className="truncate max-w-sm font-serif italic" style={{ fontSize: 14, color: 'var(--cream-600)' }}>
                          {session.summary}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </>
      )}

      <AnimatePresence>
        {entryModeRepo && (
          <EntryModeDialog
            repo={entryModeRepo}
            onSelect={handleStartSession}
            onClose={() => setEntryModeRepo(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showAddDialog && (
          <AddRepoDialog
            onClose={() => setShowAddDialog(false)}
            onAdded={() => { setShowAddDialog(false); loadRepos(); }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function glyph(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '');
  if (clean.length === 0) return '··';
  if (clean.length === 1) return clean[0].toUpperCase();
  return (clean[0] + clean[1]).toUpperCase();
}

function formatTimeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

function EntryModeDialog({ repo, onSelect, onClose }: { repo: Repo; onSelect: (mode: EntryMode) => void; onClose: () => void }) {
  const speechToasts = useAudioStore(s => s.speechToasts);
  const lastToast = speechToasts[speechToasts.length - 1];

  // Act on each toast at most ONCE. The effect used to re-fire whenever
  // `onSelect` changed identity (a fresh function every parent render),
  // double-sending session:start for the same spoken phrase.
  const consumedToastRef = useRef<unknown>(null);
  useEffect(() => {
    if (!lastToast || consumedToastRef.current === lastToast) return;
    const text = lastToast.text.toLowerCase();
    // Only react to things the user actually SAID — system/error toasts
    // ("Mic paused", fix instructions…) must never select a mode.
    if (lastToast.kind !== 'transcript' || text.startsWith('[')) return;
    let mode: EntryMode | null = null;
    if (text.includes('full') || text.includes('walkthrough') || text.includes('everything')) mode = 'full_walkthrough';
    else if (text.includes('update') || text.includes('what changed') || text.includes("what's new") || text.includes('recent')) mode = 'updates';
    else if (text.includes('onboarding') || text.includes('learn') || text.includes('program')) mode = 'onboarding';
    else if (text.includes('explore') || text.includes('manual') || text.includes('free') || text.includes('self')) mode = 'explore';
    if (mode) {
      consumedToastRef.current = lastToast;
      onSelect(mode);
    }
  }, [lastToast, onSelect]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 8, opacity: 0 }}
        className="modal-shell"
        style={{ maxWidth: 600 }}
      >
        <div className="kicker">{repo.name}</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 32, color: 'var(--cream-900)', letterSpacing: '-0.02em', fontWeight: 300 }}>
          How should we open?
        </h2>

        <div className="mt-4 flex items-center gap-3">
          <span
            style={{ width: 8, height: 8, background: 'var(--cream-500)', borderRadius: '50%', opacity: 0.5 }}
          />
          <span className="font-mono" style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
            Mic is off · click a mode (or say it once you turn the mic on in-session)
          </span>
        </div>

        <div className="mt-5 space-y-2">
          <button type="button" className="mode-card" onClick={() => onSelect('full_walkthrough')}>
            <div className="t">Full walkthrough</div>
            <div className="d">Start from scratch. Overview, architecture tour, then component-by-component.</div>
            <div className="h"><em>say</em> &ldquo;full walkthrough&rdquo;</div>
          </button>
          <button type="button" className="mode-card" onClick={() => onSelect('updates')}>
            <div className="t">Updates only</div>
            <div className="d">Just what&apos;s changed. A focused diff walkthrough since your last session.</div>
            <div className="h"><em>say</em> &ldquo;updates&rdquo; or &ldquo;what changed&rdquo;</div>
          </button>
          <button type="button" className="mode-card" onClick={() => onSelect('onboarding')}>
            <div className="t">Onboarding program</div>
            <div className="d">A structured 5-day program to learn this codebase from the ground up.</div>
            <div className="h"><em>say</em> &ldquo;onboarding&rdquo;</div>
          </button>
          <button type="button" className="mode-card" onClick={() => onSelect('explore')}>
            <div className="t">Explore</div>
            <div className="d">You lead. Ask questions, navigate, and dive into whatever interests you.</div>
            <div className="h"><em>say</em> &ldquo;explore&rdquo;</div>
          </button>
        </div>

        <div className="mt-5 flex justify-end">
          <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12.5 }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function AddRepoDialog({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [repoPath, setRepoPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ name: string; commitCount: number; contributorCount: number } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoPath.trim()) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await api.addRepo(repoPath.trim());
      if (data.alreadyExists) {
        setError('This repository is already added');
      } else {
        setResult({
          name: data.repo.name,
          commitCount: data.commitCount ?? 0,
          contributorCount: data.contributorCount ?? 0,
        });
        setTimeout(onAdded, 900);
      }
    } catch (err: any) {
      setError(err.message ?? 'Failed to add repository');
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="modal-backdrop"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.96, y: 8, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 8, opacity: 0 }}
        className="modal-shell"
      >
        <div className="kicker">New repository</div>
        <h2 className="font-serif mt-2" style={{ fontSize: 28, color: 'var(--cream-900)', letterSpacing: '-0.015em', fontWeight: 300 }}>
          Point us at a repo.
        </h2>
        <form onSubmit={handleSubmit} className="mt-5">
          <label className="kicker block mb-2">Git URL or local path</label>
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="https://github.com/user/repo or /path/to/repo"
            className="w-full px-4 py-3 font-mono text-sm rounded-lg"
            style={{
              background: 'var(--ink-000)',
              border: '1px solid oklch(1 0 0 / 0.08)',
              color: 'var(--cream-800)',
              outline: 'none',
            }}
            autoFocus
          />

          {error && (
            <div className="mt-3 text-sm" style={{ color: 'var(--sig-break)' }}>{error}</div>
          )}

          {result && (
            <div
              className="mt-3 p-3 rounded-lg"
              style={{ background: 'color-mix(in oklch, var(--sig-okay) 10%, transparent)', border: '1px solid color-mix(in oklch, var(--sig-okay) 30%, transparent)' }}
            >
              <div className="text-sm" style={{ color: 'var(--sig-okay)' }}>Repository added.</div>
              <div className="text-xs mt-1" style={{ color: 'var(--cream-500)' }}>
                {result.commitCount} commits · {result.contributorCount} contributors
              </div>
            </div>
          )}

          <div className="flex gap-3 justify-end mt-6">
            <button type="button" onClick={onClose} className="btn btn-ghost" style={{ padding: '10px 16px' }}>
              Cancel
            </button>
            <button type="submit" disabled={loading || !repoPath.trim()} className="btn btn-primary">
              {loading ? 'Checking…' : 'Add'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}
