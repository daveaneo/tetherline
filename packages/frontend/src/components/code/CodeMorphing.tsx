import { useEffect, useState } from 'react';
import { ShikiMagicMove } from 'shiki-magic-move/react';
import { createHighlighter } from 'shiki';
import type { HighlighterCore } from 'shiki/core';
import 'shiki-magic-move/style.css';

interface Props {
  oldCode: string;
  newCode: string;
  language: string;
  filePath?: string;
}

export function CodeMorphing({ oldCode, newCode, language, filePath }: Props) {
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    createHighlighter({
      themes: ['github-dark-default'],
      langs: [language || 'text'],
    }).then(h => setHighlighter(h as unknown as HighlighterCore));
  }, [language]);

  // After a brief delay, switch to new code (triggering the magic move animation)
  useEffect(() => {
    setShowNew(false);
    const timer = setTimeout(() => setShowNew(true), 500);
    return () => clearTimeout(timer);
  }, [oldCode, newCode]);

  if (!highlighter) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[#0d0d14] p-4">
        <div className="animate-pulse h-20" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[#0d0d14] overflow-hidden">
      {filePath && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] flex items-center gap-2">
          <span className="text-xs text-[var(--color-text-muted)] font-mono">{filePath}</span>
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
            {showNew ? 'after' : 'before'}
          </span>
        </div>
      )}
      <div className="p-4 overflow-x-auto text-sm [&_pre]:!bg-transparent">
        <ShikiMagicMove
          highlighter={highlighter}
          code={showNew ? newCode : oldCode}
          lang={language || 'text'}
          theme="github-dark-default"
          options={{ duration: 600, stagger: 3, lineNumbers: true }}
        />
      </div>
    </div>
  );
}
