// 'shiki/bundle/web' (web langs only) instead of the full 'shiki'
// entry — this component is also lazy-loaded, so the highlighter
// never touches the app's entry chunk.
import { useEffect, useState } from 'react';
import { codeToHtml } from 'shiki/bundle/web';
import { motion } from 'framer-motion';
import { emberTheme } from './ember-theme.js';

interface Props {
  code: string;
  language: string;
  filePath?: string;
  highlightLines?: number[];
}

export function CodeSnippet({ code, language, filePath, highlightLines = [] }: Props) {
  const [html, setHtml] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    codeToHtml(code, {
      lang: language || 'text',
      theme: emberTheme,
      decorations: highlightLines.map(line => ({
        start: { line: line - 1, character: 0 },
        end: { line: line - 1, character: Infinity },
        properties: { class: 'highlighted-line' },
      })),
    }).then(result => {
      if (!cancelled) {
        setHtml(result);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        // Fallback to plain text
        setHtml(`<pre><code>${escapeHtml(code)}</code></pre>`);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [code, language, highlightLines]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--ink-050)] overflow-hidden"
    >
      {filePath && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center justify-between">
          <span className="text-xs text-[var(--color-text-muted)] font-mono">{filePath}</span>
          <span className="text-xs text-[var(--color-text-muted)] opacity-50">{language}</span>
        </div>
      )}
      {loading ? (
        <div className="p-4 animate-pulse">
          <div className="h-4 bg-[var(--color-surface-hover)] rounded w-3/4 mb-2" />
          <div className="h-4 bg-[var(--color-surface-hover)] rounded w-1/2 mb-2" />
          <div className="h-4 bg-[var(--color-surface-hover)] rounded w-2/3" />
        </div>
      ) : (
        <div
          className="p-4 overflow-x-auto text-sm [&_pre]:!bg-transparent [&_code]:!bg-transparent [&_.highlighted-line]:bg-[var(--color-accent)]/15 [&_.highlighted-line]:border-l-2 [&_.highlighted-line]:border-[var(--color-accent)] [&_.highlighted-line]:pl-2 [&_.highlighted-line]:-ml-2"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </motion.div>
  );
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
