interface Chapter {
  id: string | number;
  label: string;
  pos: number;
}

interface TimelineProps {
  chapters: Chapter[];
  current?: number;
  onJump?: (index: number) => void;
}

export function Timeline({ chapters, current = 0, onJump }: TimelineProps) {
  if (chapters.length === 0) return null;
  const pos = chapters[current]?.pos ?? 0;
  return (
    <div className="timeline">
      <div className="timeline-track">
        <div className="timeline-fill" style={{ width: `${pos}%` }} />
        {chapters.map((c, i) => {
          const cls = i < current ? 'is-past' : i === current ? 'is-current' : '';
          return (
            <button
              key={c.id}
              type="button"
              className={`timeline-chapter ${cls}`}
              style={{ left: `${c.pos}%` }}
              onClick={() => onJump?.(i)}
              aria-label={`Jump to chapter ${i + 1}: ${c.label}`}
            >
              <div className="tick" />
              <div className="lab">
                {String(i + 1).padStart(2, '0')} · {c.label}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
