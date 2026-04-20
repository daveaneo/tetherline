import { useState } from 'react';
import { motion } from 'framer-motion';

interface Props {
  markdown: string;
  onDismiss: () => void;
}

export function SharePanel({ markdown, onDismiss }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'review-note.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="p-4 rounded-xl border border-[var(--color-green)]/30 bg-[var(--color-green)]/5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-[var(--color-green)]">Share Explanation</h3>
      <pre className="p-3 bg-[var(--color-bg)] rounded-lg text-xs font-mono overflow-auto max-h-48 text-[var(--color-text-muted)]">{markdown}</pre>
      <div className="flex gap-2">
        <button type="button" onClick={handleCopy} className="btn btn-primary">
          {copied ? 'Copied' : 'Copy to clipboard'}
        </button>
        <button type="button" onClick={handleDownload} className="btn btn-ghost">
          Download .md
        </button>
        <button type="button" onClick={onDismiss} className="btn btn-ghost">Dismiss</button>
      </div>
    </motion.div>
  );
}
