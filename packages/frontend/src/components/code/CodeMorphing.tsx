import { useEffect, useState } from 'react';
import { ShikiMagicMove } from 'shiki-magic-move/react';
// Full bundle on purpose (any-language repos); lazy-loaded chunk, so
// none of it touches the entry bundle.
import { createHighlighter } from 'shiki';
import type { HighlighterCore } from 'shiki/core';
import 'shiki-magic-move/style.css';
import { emberTheme } from './ember-theme.js';

interface Props {
  oldCode: string;
  newCode: string;
  language: string;
  filePath?: string;
}

export function CodeMorphing({ oldCode, newCode, language, filePath }: Props) {
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null);
  const [effectiveLang, setEffectiveLang] = useState(language || 'text');
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const make = (lang: string) =>
      createHighlighter({ themes: [emberTheme], langs: [lang] });
    // Unknown language must NEVER strand the panel on an infinite
    // shimmer (createHighlighter rejects for langs the bundle lacks) —
    // degrade to un-highlighted 'text' and keep the morph animation.
    make(language || 'text')
      .then(h => { if (!cancelled) { setEffectiveLang(language || 'text'); setHighlighter(h as unknown as HighlighterCore); } })
      .catch(() =>
        make('text')
          .then(h => { if (!cancelled) { setEffectiveLang('text'); setHighlighter(h as unknown as HighlighterCore); } })
          .catch(() => { /* shiki itself failed to load — keep skeleton */ }),
      );
    return () => { cancelled = true; };
  }, [language]);

  // After a brief delay, switch to new code (triggering the magic move animation)
  useEffect(() => {
    setShowNew(false);
    const timer = setTimeout(() => setShowNew(true), 500);
    return () => clearTimeout(timer);
  }, [oldCode, newCode]);

  if (!highlighter) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--ink-050)] p-4">
        <div className="animate-pulse h-20" />
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--ink-050)] overflow-hidden">
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
          lang={effectiveLang}
          theme="ember"
          options={{ duration: 600, stagger: 3, lineNumbers: true }}
        />
      </div>
    </div>
  );
}
