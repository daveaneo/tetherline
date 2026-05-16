/** deep_dive pocket presentation (B14/H6).
 *
 * The pocket "dimension": a ≤10-slide presentation that REPLACES the
 * diagram (sandbox — entering snapshots the canvas, exiting restores
 * it; same early-return structure as the grill screen). The pocket
 * STATE MACHINE lives in the tested deep-dive-pocket.ts reducer; this
 * is purely the in-theme render surface for an active pocket.
 *
 * Ember/espresso skin only; no new visual vocabulary.
 */
export interface PocketSlide {
  title: string;
  body: string;
}

export function DeepDivePocket({
  focus,
  slide,
  total,
  slides,
}: {
  focus?: string;
  slide: number;
  total: number;
  slides: PocketSlide[];
}) {
  const cur = slides[Math.min(slide, slides.length - 1)] ?? { title: '', body: '' };
  return (
    <div
      data-testid="deep-dive-pocket"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 12%',
        background:
          'radial-gradient(circle at 50% 40%, oklch(0.20 0.018 65 / 0.55), oklch(0.13 0.01 60 / 0.94))',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div style={{ width: '100%', maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div
          className="font-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: 'var(--cream-500, oklch(0.7 0.03 75))',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>Deep dive{focus ? ` · ${focus}` : ''}</span>
          <span style={{ color: 'var(--amber-400, oklch(0.74 0.12 65))' }}>
            {Math.min(slide + 1, total)} / {total}
          </span>
        </div>
        <h2
          className="font-serif"
          style={{ fontSize: 30, lineHeight: 1.2, color: 'var(--cream-100, #f4ebe1)', letterSpacing: '-0.01em', margin: 0 }}
        >
          {cur.title}
        </h2>
        <p
          className="font-serif"
          style={{ fontSize: 16, lineHeight: 1.6, color: 'var(--cream-300, #d9c9b6)', margin: 0 }}
        >
          {cur.body}
        </p>
        {/* Slide rail — progress dots, current = amber */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              style={{
                width: i === slide ? 22 : 8,
                height: 4,
                borderRadius: 2,
                background:
                  i === slide
                    ? 'var(--amber-400, oklch(0.74 0.12 65))'
                    : 'oklch(1 0 0 / 0.12)',
                transition: 'all 0.2s ease',
              }}
            />
          ))}
        </div>
        <div
          className="font-mono"
          style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--cream-500, oklch(0.7 0.03 75))', opacity: 0.7, marginTop: 4 }}
        >
          ← back · next → · "exit" to leave the dive
        </div>
      </div>
    </div>
  );
}
