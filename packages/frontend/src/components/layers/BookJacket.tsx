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
    <div className="h-full flex items-center justify-center p-12 relative overflow-hidden">
      {/* Subtle radial gradient background */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--color-surface)_0%,transparent_70%)] opacity-40" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="max-w-2xl w-full relative z-10"
      >
        {/* Project name — large, cinematic */}
        <h1 className="text-5xl md:text-6xl font-bold text-center mb-5 tracking-tight">
          {projectName}
        </h1>

        {/* Purpose — one sentence */}
        <p className="text-center text-[var(--color-text-muted)] text-xl md:text-2xl mb-12 leading-relaxed max-w-xl mx-auto">
          {purpose}
        </p>

        {/* Stats — spread out horizontally */}
        <div className="flex items-center justify-center gap-12 mb-12">
          <StatCard label="Areas" value={String(areas.length || '—')} />
          <div className="w-px h-8 bg-[var(--color-border)]/30" />
          <StatCard label="Files" value={fileCount} />
          <div className="w-px h-8 bg-[var(--color-border)]/30" />
          <StatCard label="Language" value={dominantLanguage} />
        </div>

        {/* Area chips */}
        {areas.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.4 }}
            className="flex flex-wrap justify-center gap-2.5"
          >
            {areas.slice(0, 10).map(area => (
              <span
                key={area.id}
                className="text-sm px-4 py-2 rounded-full bg-[var(--color-surface)]/60 border border-[var(--color-border)]/50 text-[var(--color-text-muted)] backdrop-blur-sm"
              >
                {area.name}
              </span>
            ))}
            {areas.length > 10 && (
              <span className="text-sm px-4 py-2 rounded-full bg-[var(--color-surface)]/40 border border-[var(--color-border)]/30 text-[var(--color-text-muted)] opacity-60">
                +{areas.length - 10} more
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
    <div className="text-center">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-[var(--color-text-muted)] mt-1 uppercase tracking-wider">{label}</div>
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
