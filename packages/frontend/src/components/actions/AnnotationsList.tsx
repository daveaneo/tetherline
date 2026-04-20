import { useState, useEffect } from 'react';
import { API_PREFIX } from '@tetherline/shared';
import { motion, AnimatePresence } from 'framer-motion';

interface Annotation {
  id: string;
  repo_path: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  node_id: string | null;
  layer: string | null;
  content: string;
  created_by: string;
  session_id: string | null;
  created_at: string;
}

interface Props {
  repoPath: string;
}

export function AnnotationsList({ repoPath }: Props) {
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (!repoPath) return;
    setLoading(true);
    fetch(`${API_PREFIX}/annotations?repoPath=${encodeURIComponent(repoPath)}`)
      .then(res => res.json())
      .then(data => {
        setAnnotations(data.annotations ?? []);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, [repoPath]);

  if (loading || annotations.length === 0) return null;

  return (
    <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] transition-colors"
      >
        <span className="transition-transform" style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
          &#x25BE;
        </span>
        <span>Notes ({annotations.length})</span>
      </button>

      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-2 max-h-64 overflow-y-auto">
              {annotations.map(a => (
                <div
                  key={a.id}
                  className="p-3 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] text-sm"
                >
                  <p className="text-[var(--color-text)] leading-relaxed">{a.content}</p>
                  <div className="flex items-center gap-2 mt-1.5 text-[10px] text-[var(--color-text-muted)]">
                    {a.file_path && (
                      <span className="font-mono">{a.file_path}</span>
                    )}
                    {a.layer && (
                      <span className="px-1.5 py-0.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] capitalize">{a.layer}</span>
                    )}
                    <span className="ml-auto">{formatDate(a.created_at)}</span>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}
