import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';

/**
 * Layer 1 — "Book Jacket" overview.
 * A clean, centered card showing the project at a glance: name, purpose, stats.
 * No diagrams, no code — think app-store listing.
 */
export function BookJacket() {
  const areas = useSessionStore(s => s.areas);
  const proposal = useSessionStore(s => s.proposal);
  const heatmap = useSessionStore(s => s.heatmap);
  const greeting = useSessionStore(s => s.greeting);

  // Derive project name from the greeting (often starts with "Welcome to <project>")
  // or from the first area name as a fallback.
  const projectName = useMemo(() => {
    if (greeting) {
      const match = greeting.match(/Welcome to (\S+)/i) ?? greeting.match(/reviewing (\S+)/i);
      if (match) return match[1].replace(/[.!,]+$/, '');
    }
    return 'Project';
  }, [greeting]);

  // Extract a one-liner purpose from the proposal message (first sentence)
  const purpose = useMemo(() => {
    if (proposal?.message) {
      const first = proposal.message.split(/[.!]\s/)[0];
      return first.length > 150 ? first.slice(0, 147) + '...' : first;
    }
    return 'Loading project information...';
  }, [proposal]);

  // File count from heatmap
  const fileCount = useMemo(() => {
    if (!heatmap) return '—';
    const entries = (heatmap as { entries?: unknown[] }).entries ?? [];
    return String(entries.length || '—');
  }, [heatmap]);

  // Dominant language from file extensions in heatmap or areas
  const dominantLanguage = useMemo(() => {
    const files: string[] = [];
    if (heatmap && (heatmap as { entries?: Array<{ filePath: string }> }).entries) {
      files.push(...(heatmap as { entries: Array<{ filePath: string }> }).entries.map(e => e.filePath));
    } else {
      files.push(...areas.flatMap(a => a.affectedFiles));
    }
    if (files.length === 0) return '—';

    const extCounts: Record<string, number> = {};
    for (const f of files) {
      const ext = f.split('.').pop()?.toLowerCase() ?? '';
      if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }
    const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return '—';
    return extToLanguage(sorted[0][0]);
  }, [heatmap, areas]);

  return (
    <div className="h-full flex items-center justify-center p-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5 }}
        className="max-w-md w-full"
      >
        {/* Project icon */}
        <div className="text-6xl text-center mb-6 opacity-60">📦</div>

        {/* Project name */}
        <h1 className="text-3xl font-bold text-center mb-3">
          {projectName}
        </h1>

        {/* Purpose — one sentence */}
        <p className="text-center text-[var(--color-text-muted)] text-lg mb-8 leading-relaxed">
          {purpose}
        </p>

        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Areas" value={String(areas.length || '—')} />
          <StatCard label="Files" value={fileCount} />
          <StatCard label="Language" value={dominantLanguage} />
        </div>

        {/* Area chips */}
        {areas.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="mt-8 flex flex-wrap justify-center gap-2"
          >
            {areas.slice(0, 8).map(area => (
              <span
                key={area.id}
                className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)]"
              >
                {area.name}
              </span>
            ))}
            {areas.length > 8 && (
              <span className="text-xs px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] text-[var(--color-text-muted)] opacity-60">
                +{areas.length - 8} more
              </span>
            )}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-center p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)]">
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    </div>
  );
}

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin',
    rb: 'Ruby', swift: 'Swift', cs: 'C#', cpp: 'C++', c: 'C', h: 'C',
    vue: 'Vue', svelte: 'Svelte', php: 'PHP', dart: 'Dart', scala: 'Scala',
    zig: 'Zig', ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', ml: 'OCaml',
    hs: 'Haskell', lua: 'Lua', sh: 'Shell', bash: 'Shell', zsh: 'Shell',
    css: 'CSS', scss: 'SCSS', html: 'HTML', sql: 'SQL',
  };
  return map[ext] ?? ext.toUpperCase();
}
