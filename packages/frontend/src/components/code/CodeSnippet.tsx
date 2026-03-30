import { motion } from 'framer-motion';

interface Props {
  code: string;
  language: string;
  filePath?: string;
  highlightLines?: number[];
}

export function CodeSnippet({ code, language, filePath, highlightLines = [] }: Props) {
  const lines = code.split('\n');

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[#0d0d14] overflow-hidden">
      {filePath && (
        <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
          <span className="text-xs text-[var(--color-text-muted)] font-mono">{filePath}</span>
          <span className="text-xs text-[var(--color-text-muted)] ml-2 opacity-50">{language}</span>
        </div>
      )}
      <pre className="p-4 overflow-x-auto text-sm font-mono leading-6">
        {lines.map((line, i) => {
          const lineNum = i + 1;
          const isHighlighted = highlightLines.includes(lineNum);
          return (
            <motion.div
              key={i}
              animate={{
                backgroundColor: isHighlighted ? 'rgba(99, 102, 241, 0.15)' : 'transparent',
              }}
              transition={{ duration: 0.3 }}
              className="flex"
            >
              <span className="w-10 text-right pr-4 text-[var(--color-text-muted)] opacity-40 select-none flex-shrink-0">
                {lineNum}
              </span>
              <code className="text-[var(--color-text)]">{line || ' '}</code>
            </motion.div>
          );
        })}
      </pre>
    </div>
  );
}
