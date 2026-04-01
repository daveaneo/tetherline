import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/api-client.js';
import { sendEvent } from '../../lib/ws-client.js';
import { useAudioStore } from '../../state/audio-store.js';
import { motion, AnimatePresence } from 'framer-motion';
import type { EntryMode } from '@interactive-reviewer/shared';

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

export function Lobby() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [keyStatus, setKeyStatus] = useState<{ hasAnthropicKey: boolean; hasOpenaiKey: boolean } | null>(null);

  const loadRepos = useCallback(async () => {
    try {
      const data = await api.listRepos();
      setRepos(data.repos);
    } catch (err) {
      console.error('Failed to load repos:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRepos(); }, [loadRepos]);

  useEffect(() => {
    api.health().then(data => setKeyStatus({ hasAnthropicKey: data.hasAnthropicKey, hasOpenaiKey: data.hasOpenaiKey })).catch(() => {});
  }, []);

  const handleSelectRepo = (repo: Repo) => {
    setSelectedRepo(repo);
    // Start mic from this click handler (user gesture = browser allows mic access)
    const { requestMicStart } = useAudioStore.getState();
    requestMicStart();
  };

  const handleStartSession = (mode: EntryMode) => {
    if (!selectedRepo) return;
    // Start mic from this click handler (user gesture = browser allows mic access)
    const { requestMicStart } = useAudioStore.getState();
    requestMicStart();
    sendEvent({ type: 'session:start', payload: { repoPath: selectedRepo.path, sinceDays: 7, entryMode: mode } });
    setSelectedRepo(null);
  };

  const handleRepoAdded = () => {
    setShowAddDialog(false);
    loadRepos();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-pulse text-[var(--color-text-muted)]">Loading repositories...</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto w-full p-8">
      {/* API key warning banner */}
      {keyStatus && !keyStatus.hasAnthropicKey && (
        <div className="mb-6 p-4 rounded-xl border border-amber-500/30 bg-amber-500/5">
          <p className="text-sm text-amber-400">
            No Anthropic API key detected. AI narration and analysis won't work.
            Add <code className="text-xs bg-[var(--color-bg)] px-1 rounded">ANTHROPIC_API_KEY</code> to your .env file.
          </p>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <div>
          <h1 className="text-3xl font-bold">Interactive Reviewer</h1>
          <p className="text-[var(--color-text-muted)] mt-1">Select a repository to begin your review session</p>
        </div>
        <button
          onClick={() => setShowAddDialog(true)}
          className="flex items-center gap-2 px-5 py-2.5 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-sm font-medium transition-colors"
        >
          <span className="text-lg">+</span> Add Repository
        </button>
      </div>

      {/* Repo Grid */}
      {repos.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-5xl mb-4 opacity-30">&#128193;</div>
          <h2 className="text-xl font-semibold mb-2">No repositories yet</h2>
          <p className="text-[var(--color-text-muted)] mb-6">Add a git repository to start your first review session</p>
          <button
            onClick={() => setShowAddDialog(true)}
            className="px-6 py-3 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg transition-colors"
          >
            Add Your First Repository
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {repos.map((repo, i) => (
            <motion.button
              key={repo.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
              onClick={() => handleSelectRepo(repo)}
              className="text-left p-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-accent)]/50 transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-lg group-hover:text-[var(--color-accent)] transition-colors">{repo.name}</h3>
                {repo.totalSessions > 0 && (
                  <span className="text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)] px-2 py-0.5 rounded-full">
                    {repo.totalSessions} session{repo.totalSessions !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Understanding bar */}
              <div className="mb-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-[var(--color-text-muted)]">Understanding</span>
                  <span className="text-xs font-medium">{Math.round(repo.understandingPct)}%</span>
                </div>
                <div className="h-2 bg-[var(--color-bg)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${repo.understandingPct}%`,
                      background: repo.understandingPct > 70
                        ? 'var(--color-green)'
                        : repo.understandingPct > 40
                        ? 'var(--color-yellow)'
                        : 'var(--color-red)',
                    }}
                  />
                </div>
              </div>

              {/* Meta */}
              <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
                {repo.lastReviewedAt ? (
                  <span>Last: {formatTimeAgo(repo.lastReviewedAt)}</span>
                ) : (
                  <span className="text-[var(--color-yellow)]">Never reviewed</span>
                )}
              </div>

              {/* Path */}
              <div className="mt-2 text-xs text-[var(--color-text-muted)] opacity-50 truncate font-mono">
                {repo.path}
              </div>
            </motion.button>
          ))}
        </div>
      )}

      {/* Entry Mode Selection */}
      <AnimatePresence>
        {selectedRepo && (
          <EntryModeDialog
            repo={selectedRepo}
            onSelect={handleStartSession}
            onClose={() => setSelectedRepo(null)}
          />
        )}
      </AnimatePresence>

      {/* Add Dialog */}
      <AnimatePresence>
        {showAddDialog && (
          <AddRepoDialog onClose={() => setShowAddDialog(false)} onAdded={handleRepoAdded} />
        )}
      </AnimatePresence>
    </div>
  );
}

function EntryModeDialog({ repo, onSelect, onClose }: { repo: Repo; onSelect: (mode: EntryMode) => void; onClose: () => void }) {
  const speechToasts = useAudioStore(s => s.speechToasts);
  const lastToast = speechToasts[speechToasts.length - 1];

  useEffect(() => {
    if (!lastToast) return;
    const text = lastToast.text.toLowerCase();
    if (text.startsWith('[')) return; // ignore system toasts like [Mic: started]
    if (text.includes('full') || text.includes('walkthrough') || text.includes('everything')) {
      onSelect('full_walkthrough');
    } else if (text.includes('update') || text.includes('what changed') || text.includes("what's new") || text.includes('recent')) {
      onSelect('updates');
    }
  }, [lastToast, onSelect]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        className="w-full max-w-lg mx-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-6"
      >
        <div className="mb-5">
          <h2 className="text-xl font-semibold">{repo.name}</h2>
          <div className="flex items-center gap-3 mt-2">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-[var(--color-text-muted)]">Understanding</span>
                <span className="text-xs font-medium">{Math.round(repo.understandingPct)}%</span>
              </div>
              <div className="h-1.5 bg-[var(--color-bg)] rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${repo.understandingPct}%`,
                    background: repo.understandingPct > 70
                      ? 'var(--color-green)'
                      : repo.understandingPct > 40
                      ? 'var(--color-yellow)'
                      : 'var(--color-red)',
                  }}
                />
              </div>
            </div>
          </div>
        </div>

        <p className="text-sm text-[var(--color-text-muted)] mb-5">How would you like to review this repository? You can also say your choice.</p>

        <div className="space-y-3">
          <button
            onClick={() => onSelect('full_walkthrough')}
            className="w-full text-left p-4 rounded-xl border border-[var(--color-border)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-hover)] transition-all group"
          >
            <div className="flex items-center gap-3 mb-1">
              <span className="text-lg">&#128218;</span>
              <h3 className="font-medium group-hover:text-[var(--color-accent)] transition-colors">Full Walkthrough</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] ml-8">
              Start from scratch. Get a project overview, architecture tour, and component-by-component walkthrough.
            </p>
            <p className="text-xs text-[var(--color-text-muted)] ml-8 mt-1 opacity-60">or say "full walkthrough"</p>
          </button>

          <button
            onClick={() => onSelect('updates')}
            className="w-full text-left p-4 rounded-xl border border-[var(--color-border)] hover:border-[var(--color-accent)]/50 hover:bg-[var(--color-surface-hover)] transition-all group"
          >
            <div className="flex items-center gap-3 mb-1">
              <span className="text-lg">&#128260;</span>
              <h3 className="font-medium group-hover:text-[var(--color-accent)] transition-colors">Updates Only</h3>
            </div>
            <p className="text-sm text-[var(--color-text-muted)] ml-8">
              Review recent changes. See what happened since your last session with a focused diff walkthrough.
            </p>
            <p className="text-xs text-[var(--color-text-muted)] ml-8 mt-1 opacity-60">or say "updates"</p>
          </button>
        </div>

        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          >
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
        setTimeout(onAdded, 1000);
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <motion.div
        initial={{ scale: 0.95, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.95, y: 10 }}
        className="w-full max-w-md mx-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl p-6"
      >
        <h2 className="text-xl font-semibold mb-4">Add Repository</h2>

        <form onSubmit={handleSubmit}>
          <label className="block text-sm text-[var(--color-text-muted)] mb-1.5">Git URL or local path</label>
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="https://github.com/user/repo or /path/to/local/repo"
            className="w-full px-4 py-2.5 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-accent)] mb-4"
            autoFocus
          />

          {error && (
            <div className="text-sm text-red-400 mb-4">{error}</div>
          )}

          {result && (
            <div className="p-3 bg-[var(--color-bg)] rounded-lg mb-4 space-y-1">
              <div className="text-sm text-[var(--color-green)]">Repository added!</div>
              <div className="text-xs text-[var(--color-text-muted)]">{result.commitCount} commits from {result.contributorCount} contributors</div>
            </div>
          )}

          <div className="flex gap-3 justify-end">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !repoPath.trim()}
              className="px-6 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-sm disabled:opacity-50 transition-colors"
            >
              {loading ? 'Checking...' : 'Add'}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
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
