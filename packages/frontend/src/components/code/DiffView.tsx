interface Props {
  filePath: string;
  hunks: Array<{ content: string }>;
}

export function DiffView({ filePath, hunks }: Props) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[#0d0d14] overflow-hidden">
      <div className="px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <span className="text-xs text-[var(--color-text-muted)] font-mono">{filePath}</span>
      </div>
      <pre className="p-4 overflow-x-auto text-sm font-mono leading-6">
        {hunks.map((hunk, hi) => (
          <div key={hi}>
            {hunk.content.split('\n').map((line, li) => {
              let bgClass = '';
              let textClass = 'text-[var(--color-text)]';

              if (line.startsWith('+') && !line.startsWith('+++')) {
                bgClass = 'bg-green-900/20';
                textClass = 'text-green-400';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                bgClass = 'bg-red-900/20';
                textClass = 'text-red-400';
              } else if (line.startsWith('@@')) {
                textClass = 'text-blue-400';
              }

              return (
                <div key={`${hi}-${li}`} className={`px-2 ${bgClass}`}>
                  <code className={textClass}>{line || ' '}</code>
                </div>
              );
            })}
          </div>
        ))}
      </pre>
    </div>
  );
}
