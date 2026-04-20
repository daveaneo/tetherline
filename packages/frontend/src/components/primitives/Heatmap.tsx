interface HeatmapProps {
  values: number[][];
  cols?: number;
  highlight?: { r: number; c: number } | null;
}

export function Heatmap({ values, cols, highlight = null }: HeatmapProps) {
  const columnCount = cols ?? (values[0]?.length ?? 12);
  return (
    <div className="heatmap" style={{ ['--hm-cols' as string]: String(columnCount) }}>
      {values.flatMap((row, r) =>
        row.map((v, c) => {
          const isHi = !!highlight && highlight.r === r && highlight.c === c;
          return (
            <div
              key={`${r}-${c}`}
              className="heatmap-cell"
              data-heat={Math.max(0, Math.min(5, Math.round(v)))}
              style={isHi ? { outline: '1px solid var(--amber-400)', outlineOffset: 1 } : undefined}
            />
          );
        })
      )}
    </div>
  );
}
