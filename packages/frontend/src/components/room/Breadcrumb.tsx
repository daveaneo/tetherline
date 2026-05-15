/** Always-visible "you are here" crumb (B16). Low-weight chrome,
 *  ember/espresso skin: dimmed spine, amber live position. The
 *  subway model's required orientation surface. */
import { buildBreadcrumb, breadcrumbText, type BreadcrumbInput } from './breadcrumb.js';

export function Breadcrumb(props: BreadcrumbInput) {
  const crumbs = buildBreadcrumb(props);
  return (
    <div
      data-testid="you-are-here"
      aria-label={`You are here: ${breadcrumbText(crumbs)}`}
      className="font-mono"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span style={{ opacity: 0.35, color: 'var(--cream-500)' }}>▸</span>}
          <span
            style={{
              color:
                c.kind === 'slide'
                  ? 'var(--amber-400, oklch(0.74 0.12 65))'
                  : c.current
                    ? 'var(--cream-200, #e8dcc8)'
                    : 'var(--cream-500)',
              opacity: c.kind === 'spine' && !c.current ? 0.5 : 1,
              fontWeight: c.current ? 600 : 400,
            }}
          >
            {c.label}
          </span>
        </span>
      ))}
    </div>
  );
}
