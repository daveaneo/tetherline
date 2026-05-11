/**
 * HermesDiagram — the project's centerpiece visual.
 *
 * Replaces the legacy DiagramPanel. Renders the pre-warmed diagram
 * payload from /api/diagram in a polished radial layout:
 *
 *   • Center node = current focus, larger, gradient fill, drop shadow,
 *     comprehension halo, pulses while Hermes narrates it.
 *   • Satellites = children, sized by `weight`, arranged on a circle.
 *   • Edges = curved bezier paths with proper arrowheads. Edge stroke
 *     style varies by kind (imports / produces / configures / etc.).
 *   • Title bar above the canvas: project / module name in serif +
 *     a one-line description (≤80 chars) in mono.
 *   • Click a node → "tell me about <node>" utterance + visual focus.
 *
 * The cached payload comes from the diagram-warmer at session start,
 * so first paint is immediate. Cache miss → loading state while the
 * backend composes on the fly.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';
import { useAudioStore } from '../../state/audio-store.js';
import { sendEvent } from '../../lib/ws-client.js';
import { API_PREFIX } from '@tetherline/shared';

interface DiagramNode {
  id: string;
  label: string;
  description?: string;
  role?: string;
  weight?: number;
  level?: 'unknown' | 'mentioned' | 'heard' | 'engaged' | 'explained' | 'confirmed';
  briefingId?: string;
}
interface DiagramEdge {
  from: string;
  to: string;
  kind?: 'contains' | 'produces' | 'consumes' | 'configures' | 'guards' | 'imports';
  label?: string;
}
interface DiagramPayload {
  scope: string;
  view: 'logic' | 'file';
  title: string;
  subtitle: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

interface PositionedNode extends DiagramNode {
  x: number;
  y: number;
  radius: number;
  isCenter: boolean;
}

const VIEWBOX_W = 1200;
const VIEWBOX_H = 760;
const CENTER_X = VIEWBOX_W / 2;
const CENTER_Y = VIEWBOX_H / 2;
// Center bumped from 78→100 because module-scope drills with 5+ file
// satellites stretch the dynamic viewBox wide enough that an only-11%-
// bigger center stops reading as "this is the focus". A bigger center
// keeps the visual hierarchy regardless of how many satellites orbit.
const CENTER_RADIUS = 100;
const SATELLITE_RADIUS_MIN = 50;
const SATELLITE_RADIUS_MAX = 70;
const ORBIT_RADIUS = 290;

export function HermesDiagram() {
  const repoPath = useSessionStore(s => s.activeRepoPath);
  const phase = useSessionStore(s => s.state.phase);
  const currentBriefingId = useSessionStore(s => s.currentBriefing?.briefingId ?? null);

  // Active scope walks the navigator stack — drilling into a module
  // refetches that module's diagram. For now wire to project until the
  // navigator integration lands; the structure is here for it.
  const [scope, setScope] = useState<string>('project');
  const [view] = useState<'logic' | 'file'>('file'); // logic-toggle in next round
  const [payload, setPayload] = useState<DiagramPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to project when phase resets to IDLE.
  useEffect(() => {
    if (phase === 'IDLE') setScope('project');
  }, [phase]);

  // Fetch the diagram payload whenever scope/view/repoPath changes.
  useEffect(() => {
    if (!repoPath || phase === 'IDLE') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url = `${API_PREFIX}/diagram?repoPath=${encodeURIComponent(repoPath)}&scope=${encodeURIComponent(scope)}&view=${view}`;
    fetch(url)
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ diagram: DiagramPayload }>;
      })
      .then(j => {
        if (cancelled) return;
        setPayload(j.diagram);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [repoPath, scope, view, phase]);

  const positioned = useMemo<PositionedNode[]>(() => {
    if (!payload) return [];
    const nodes = payload.nodes;
    if (nodes.length === 0) return [];
    const center = nodes[0];
    const satellites = nodes.slice(1);
    const out: PositionedNode[] = [
      { ...center, x: CENTER_X, y: CENTER_Y, radius: CENTER_RADIUS, isCenter: true },
    ];
    const n = satellites.length;
    if (n === 0) return out;
    // Layout per N satellites — n=2 must spread horizontally (the
    // even-distribution starting at top puts both on the vertical
    // axis, which collapses to a column visually).
    const angles = computeAngles(n);
    for (let i = 0; i < n; i++) {
      const w = clamp(satellites[i].weight ?? 0.7, 0.4, 1);
      const radius = SATELLITE_RADIUS_MIN + (SATELLITE_RADIUS_MAX - SATELLITE_RADIUS_MIN) * w;
      // Allow the orbit to stretch horizontally on wide screens — the
      // viewBox is 1200×760 and we have visual room out to ±540 on x.
      const orbitX = ORBIT_RADIUS * 1.35;
      const orbitY = ORBIT_RADIUS * 0.95;
      out.push({
        ...satellites[i],
        x: CENTER_X + Math.cos(angles[i]) * orbitX,
        y: CENTER_Y + Math.sin(angles[i]) * orbitY,
        radius,
        isCenter: false,
      });
    }
    return out;
  }, [payload]);

  const nodeById = useMemo(() => new Map(positioned.map(n => [n.id, n])), [positioned]);

  // Tight viewBox around the actual node bounds (+ padding for halos /
  // pulse rings / arrowheads). Without this, sparse layouts (e.g. n=2
  // satellites all on a horizontal line) leave huge vertical dead space.
  const viewBox = useMemo(() => {
    if (positioned.length === 0) return { x: 0, y: 0, w: VIEWBOX_W, h: VIEWBOX_H };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of positioned) {
      const halfW = n.radius * 1.55;
      const halfH = n.radius * 0.78;
      if (n.x - halfW < minX) minX = n.x - halfW;
      if (n.x + halfW > maxX) maxX = n.x + halfW;
      if (n.y - halfH < minY) minY = n.y - halfH;
      if (n.y + halfH > maxY) maxY = n.y + halfH;
    }
    const pad = 48;
    return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  }, [positioned]);

  if (phase === 'IDLE') return null;
  if (error) {
    return (
      <div className="flex items-center justify-center h-full" style={{ color: 'var(--cream-500)' }}>
        Couldn't load diagram: {error}
      </div>
    );
  }
  if (!payload || loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div
          className="font-mono"
          style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)', opacity: 0.7 }}
        >
          Composing diagram…
        </div>
      </div>
    );
  }

  const onNodeClick = (n: PositionedNode) => {
    if (n.isCenter) return; // don't drill on the center
    const utterance = `tell me about ${prettyLabel(n)}`;
    useSessionStore.getState().addConversation('you', utterance);
    useAudioStore.getState().setVoiceState('processing');
    sendEvent({ type: 'user:utterance', payload: { text: utterance, timestamp: Date.now() } });
    // Drill — switch the cached scope to that node.
    if (n.id.startsWith('module/')) setScope(n.id);
  };

  // The diagram's own title bar should only show when the diagram is
  // the canvas — i.e. narrative phases or PROPOSAL (where it floats
  // visibly behind the proposal card). During ANALYZING / ERROR / WRAP
  // the ContentPanel owns the page header and a second one underneath
  // would duplicate it (the user flagged this in the round-2 walk).
  const TITLE_PHASES = new Set([
    'OVERVIEW', 'AREA_WALKTHROUGH', 'COMPONENT_TOUR', 'PROJECT_OVERVIEW',
    'ARCHITECTURE_OVERVIEW', 'PREVIOUSLY_ON', 'HEATMAP', 'QA',
    'AREA_TRANSITION', 'PROPOSAL',
  ]);
  const showTitle = TITLE_PHASES.has(phase);

  return (
    <div
      className="h-full flex flex-col mx-auto"
      data-testid="hermes-diagram"
      style={{ maxWidth: 1280 }}
    >
      {/* ── Title bar ─────────────────────────────────────────────────── */}
      {showTitle && (
        <header
          className="flex flex-col items-start"
          style={{ padding: '24px 32px 12px' }}
        >
          <div
            className="font-mono flex items-center gap-2"
            style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)', opacity: 0.85 }}
          >
            {scope.startsWith('module/') && (
              <button
                type="button"
                onClick={() => setScope('project')}
                className="font-mono"
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'oklch(1 0 0 / 0.04)',
                  border: '1px solid oklch(1 0 0 / 0.08)',
                  color: 'var(--cream-500)',
                  fontSize: 10,
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  cursor: 'pointer',
                }}
                aria-label="Back to project view"
                data-testid="hermes-diagram-back"
              >
                ← Project
              </button>
            )}
            <span>
              {scope === 'project' ? 'Project' : scope.replace(/^module\//, 'Module · ')}
              {' · '}
              {view === 'logic' ? 'Logic flow' : 'File map'}
            </span>
          </div>
          <h1
            className="font-serif"
            style={{ fontSize: 32, color: 'var(--cream-100)', letterSpacing: '-0.015em', margin: '6px 0 8px', fontWeight: 400 }}
          >
            {payload.title}
          </h1>
          {payload.subtitle && (
            <p
              className="font-mono"
              style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cream-500)', maxWidth: 760, margin: 0 }}
            >
              {payload.subtitle}
            </p>
          )}
        </header>
      )}

      {/* ── Canvas ──────────────────────────────────────────────────────
          The wrapper is a flex region; the inner div uses aspect-ratio to
          match the dynamic viewBox so the SVG fills its element edge-to-
          edge instead of leaving wide vertical bars from `xMidYMid meet`. */}
      <div className="flex-1 relative flex items-start justify-center" style={{ minHeight: 0, padding: '8px 24px 24px' }}>
        <div
          className="relative"
          style={{
            width: '100%',
            aspectRatio: `${viewBox.w} / ${viewBox.h}`,
            maxHeight: '100%',
            maxWidth: viewBox.w * 1.2, // small upscale ceiling so we never balloon past natural size
          }}
        >
        <svg
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
          preserveAspectRatio="xMidYMid meet"
          style={{ width: '100%', height: '100%', display: 'block' }}
          data-testid="hermes-diagram-svg"
        >
          <defs>
            {/* Drop-shadow for nodes */}
            <filter id="hd-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="6" />
              <feOffset dy="3" />
              <feComponentTransfer><feFuncA type="linear" slope="0.45" /></feComponentTransfer>
              <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {/* Soft glow (active / hover) */}
            <filter id="hd-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {/* Node fill — subtle gradient lit from above */}
            <linearGradient id="hd-fill-default" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.22 0.02 60)" />
              <stop offset="100%" stopColor="oklch(0.16 0.018 50)" />
            </linearGradient>
            <linearGradient id="hd-fill-center" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.26 0.04 70)" />
              <stop offset="100%" stopColor="oklch(0.18 0.025 55)" />
            </linearGradient>
            <linearGradient id="hd-fill-active" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.34 0.10 65)" />
              <stop offset="100%" stopColor="oklch(0.22 0.06 55)" />
            </linearGradient>
            {/* Arrowhead marker — sized for the standard 1.4px stroke */}
            <marker id="hd-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="oklch(0.55 0.04 70)" />
            </marker>
            <marker id="hd-arrow-dim" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="oklch(0.45 0.025 70)" opacity="0.6" />
            </marker>
          </defs>

          {/* Edges first — under nodes */}
          <g>
            {payload.edges.map((edge, i) => {
              const a = nodeById.get(edge.from);
              const b = nodeById.get(edge.to);
              if (!a || !b) return null;
              const path = curvedPath(a, b);
              const stroke = edgeStroke(edge.kind);
              // Containment spokes are structural — the radial layout
              // already conveys "project contains module", so an
              // arrowhead would impose a misleading dependency reading.
              // Reserve markers for semantic edges (imports / guards /
              // produces / consumes / configures).
              const showMarker = edge.kind !== 'contains';
              const marker = stroke.markerOpacity > 0.5 ? 'hd-arrow' : 'hd-arrow-dim';
              return (
                <path
                  key={`e-${i}`}
                  d={path}
                  fill="none"
                  stroke={stroke.color}
                  strokeWidth={stroke.width}
                  strokeDasharray={stroke.dash}
                  strokeLinecap="round"
                  markerEnd={showMarker ? `url(#${marker})` : undefined}
                  data-testid={`hd-edge-${edge.from}-${edge.to}`}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g>
            {positioned.map(n => (
              <DiagramNodeView
                key={n.id}
                node={n}
                active={n.briefingId !== null && n.briefingId === currentBriefingId}
                onClick={() => onNodeClick(n)}
              />
            ))}
          </g>
        </svg>
        </div>
      </div>
    </div>
  );
}

interface NodeViewProps {
  node: PositionedNode;
  active: boolean;
  onClick: () => void;
}

function DiagramNodeView({ node, active, onClick }: NodeViewProps) {
  const [hover, setHover] = useState(false);
  const fill = active
    ? 'url(#hd-fill-active)'
    : node.isCenter
      ? 'url(#hd-fill-center)'
      : 'url(#hd-fill-default)';
  const haloColor = levelColor(node.level);
  // Title size tracks node size — center has the biggest type. The
  // satellite size was bumped from 14→17 because file-scope drill views
  // (n=5+ filename satellites) were unreadable at the default zoom.
  const titleSize = node.isCenter ? 24 : 17;
  const subSize = node.isCenter ? 13 : 12;
  const lineHeight = subSize * 1.4;

  // Polished layout: wider rect (3.6× radius vs old 3.1×) so subtitle
  // text has horizontal room to breathe. Height grows with line count
  // so the text never crowds the border. Padding values are explicit
  // (not derived from radius) so the visual rhythm is consistent across
  // node sizes.
  const innerPadX = 18;
  const padTop = 16;
  const padBottom = 16;
  const titleSubGap = 10; // breathing room between title and first subtitle line
  const rectWidth = node.radius * 3.6;
  const innerWidth = rectWidth - 2 * innerPadX;
  const lines = node.description
    ? wrapForRect(node.description, innerWidth, subSize, 3)
    : [];
  const contentHeight =
    titleSize + (lines.length > 0 ? titleSubGap + lines.length * lineHeight : 0);
  const rectHeight = Math.max(
    node.radius * 1.56,
    contentHeight + padTop + padBottom,
  );

  // Anchor: title sits at the top with `padTop` clearance; subtitle
  // lines stack below it with `titleSubGap` separation and consistent
  // line-height. We use dominantBaseline="hanging" so y-coordinates are
  // the top of each glyph row (predictable layout, no per-font drift).
  const titleY = -rectHeight / 2 + padTop;
  const subtitleStartY = titleY + titleSize + titleSubGap;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ cursor: node.isCenter ? 'default' : 'pointer' }}
      data-testid={`hd-node-${node.id}`}
      data-active={active ? 'true' : 'false'}
    >
      {/* Pulse ring — only for the active (currently-narrated) node */}
      {active && (
        <circle
          r={node.radius + 14}
          fill="none"
          stroke="oklch(0.78 0.16 70)"
          strokeWidth={1.5}
          opacity={0.55}
        >
          <animate attributeName="r" values={`${node.radius + 6};${node.radius + 22};${node.radius + 6}`} dur="2.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.65;0.1;0.65" dur="2.4s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Comprehension halo — thin colored ring around the node */}
      {haloColor && (
        <circle
          r={node.radius + 4}
          fill="none"
          stroke={haloColor}
          strokeWidth={2}
          opacity={0.65}
        />
      )}
      {/* Node body — pill (rounded rect) tall enough for the title +
       *  wrapped subtitle with consistent inner padding. */}
      <rect
        x={-rectWidth / 2}
        y={-rectHeight / 2}
        width={rectWidth}
        height={rectHeight}
        rx={14}
        ry={14}
        fill={fill}
        stroke={hover ? 'oklch(0.55 0.10 70)' : 'oklch(0.40 0.03 70)'}
        strokeWidth={hover ? 1.5 : 1}
        filter="url(#hd-shadow)"
      />
      {/* Title — top-aligned with consistent padding from the rect edge. */}
      <text
        textAnchor="middle"
        dominantBaseline="hanging"
        x={0}
        y={titleY}
        style={{
          fontFamily: 'var(--serif, Fraunces, serif)',
          fontSize: titleSize,
          fontWeight: 500,
          fill: 'var(--cream-100, #f4ebe1)',
          letterSpacing: '-0.005em',
        }}
      >
        {prettyLabel(node)}
      </text>
      {/* Subtitle — wraps to 3 lines, stacked under the title with
       *  consistent line-height. Centered (SVG can't do true full-
       *  justification without character distortion). */}
      {lines.length > 0 && (
        <text
          textAnchor="middle"
          dominantBaseline="hanging"
          style={{
            fontFamily: 'var(--mono, "Geist Mono", ui-monospace, monospace)',
            fontSize: subSize,
            fill: 'var(--cream-500, #b8a99a)',
            opacity: 0.9,
          }}
        >
          {lines.map((line, i) => (
            <tspan key={i} x={0} y={subtitleStartY + i * lineHeight}>{line}</tspan>
          ))}
        </text>
      )}
    </g>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

/** Angle assignment per satellite count. The even-distribution starting
 *  at top works for n>=3 but collapses n=2 to top+bottom (both at x=0
 *  offset from center — a vertical column). Special-case the small
 *  cases for cleaner layouts. */
function computeAngles(n: number): number[] {
  if (n === 0) return [];
  if (n === 1) return [-Math.PI / 2];                     // top
  if (n === 2) return [Math.PI, 0];                       // left, right
  if (n === 3) return [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]; // top + lower-right + lower-left
  if (n === 4) return [-Math.PI / 2, 0, Math.PI / 2, Math.PI];        // compass points
  // n >= 5: even distribution starting at top, clockwise
  const start = -Math.PI / 2;
  return Array.from({ length: n }, (_, i) => start + (2 * Math.PI * i) / n);
}

function prettyLabel(n: { id: string; label: string }): string {
  return n.label || n.id.replace(/^module\//, '').replace(/^file\//, '').replace(/^code\//, '');
}

/** Path from node A's edge → node B's edge. Spokes off the center node
 *  render as straight lines (radial layout already separates them — a
 *  curved bezier on a spoke produces awkward asymmetry where one side
 *  bows up and the other bows down). Cross-edges (satellite↔satellite)
 *  use a gentle organic curve to avoid passing over the center node. */
function curvedPath(a: PositionedNode, b: PositionedNode): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  const ux = dx / dist;
  const uy = dy / dist;
  // Trim by approx pill-rect radius so the line stops at the visual
  // edge of the node and the arrowhead lands outside.
  const trimA = a.radius * 1.55;
  const trimB = b.radius * 1.55 + 8;
  const ax = a.x + ux * trimA;
  const ay = a.y + uy * trimA;
  const bx = b.x - ux * trimB;
  const by = b.y - uy * trimB;
  // Spokes from / to the center → straight line.
  if (a.isCenter || b.isCenter) {
    return `M ${ax} ${ay} L ${bx} ${by}`;
  }
  // Cross-edges → cubic bezier with perpendicular bow.
  const perpX = -uy;
  const perpY = ux;
  const bow = Math.min(60, dist * 0.12);
  const c1x = ax + ux * dist * 0.32 + perpX * bow;
  const c1y = ay + uy * dist * 0.32 + perpY * bow;
  const c2x = bx - ux * dist * 0.32 + perpX * bow;
  const c2y = by - uy * dist * 0.32 + perpY * bow;
  return `M ${ax} ${ay} C ${c1x} ${c1y} ${c2x} ${c2y} ${bx} ${by}`;
}

function edgeStroke(kind: DiagramEdge['kind']): { color: string; width: number; dash: string | undefined; markerOpacity: number } {
  switch (kind) {
    case 'contains':   return { color: 'oklch(0.42 0.025 65)', width: 1.1, dash: undefined,  markerOpacity: 0.35 };
    case 'imports':    return { color: 'oklch(0.55 0.06 65)',  width: 1.3, dash: '5 4',      markerOpacity: 0.7 };
    case 'configures': return { color: 'oklch(0.55 0.05 70)',  width: 1.2, dash: '4 4',      markerOpacity: 0.7 };
    case 'guards':     return { color: 'oklch(0.62 0.10 30)',  width: 1.4, dash: '2 4',      markerOpacity: 0.85 };
    case 'consumes':
    case 'produces':
    default:           return { color: 'oklch(0.68 0.07 65)',  width: 1.5, dash: undefined,  markerOpacity: 0.9 };
  }
}

function levelColor(level: DiagramNode['level']): string | null {
  // Stronger chroma gap between levels so halos READ as comprehension
  // signal, not decoration. Cool olive for cold → warm amber → ember
  // gold for confirmed.
  switch (level) {
    case 'confirmed': return 'oklch(0.82 0.18 95)';   // warm gold, high chroma
    case 'explained': return 'oklch(0.74 0.15 75)';   // amber
    case 'engaged':   return 'oklch(0.62 0.11 65)';   // ember
    case 'heard':     return 'oklch(0.52 0.07 60)';   // dim warm
    case 'mentioned': return 'oklch(0.42 0.04 65)';   // very dim
    default:          return null; // unknown / undefined → no halo
  }
}

/** Word-wrap `text` into up to `maxLines` lines that each fit within
 *  `maxPx` of horizontal space at the given font size. SVG text doesn't
 *  auto-wrap, so we tokenize on whitespace and greedy-fit per line.
 *  Average glyph width for our mono font is ~0.55em, with some slack
 *  for descenders/spacing.
 *
 *  If the text doesn't fit in `maxLines`, the last line gets a trailing
 *  ellipsis. Otherwise (the common case for 3-4 line subtitles), the
 *  whole description renders unbroken. */
function wrapForRect(text: string, maxPx: number, fontSize: number, maxLines: number): string[] {
  const charWidth = fontSize * 0.55;
  const safeWidth = maxPx - 24; // leave 12px padding each side
  const maxChars = Math.max(8, Math.floor(safeWidth / charWidth));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    // Word itself longer than line: hard-break it.
    if (word.length > maxChars) {
      let remainder = word;
      while (remainder.length > maxChars && lines.length < maxLines - 1) {
        lines.push(remainder.slice(0, maxChars));
        remainder = remainder.slice(maxChars);
      }
      current = remainder;
    } else {
      current = word;
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  // If we ran out of room mid-text, append an ellipsis to the last line.
  if (lines.length === maxLines) {
    const consumed = lines.join(' ').length;
    if (consumed < text.length - 1) {
      const last = lines[lines.length - 1];
      lines[lines.length - 1] = last.length > maxChars - 2
        ? last.slice(0, maxChars - 2) + '…'
        : last + '…';
    }
  }
  return lines;
}
