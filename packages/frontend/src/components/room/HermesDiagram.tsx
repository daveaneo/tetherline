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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';
import { useAudioStore } from '../../state/audio-store.js';
import { TimeSlider } from './TimeSlider.js';
import { sendEvent } from '../../lib/ws-client.js';
import { API_PREFIX } from '@tetherline/shared';

type Level = 'unknown' | 'mentioned' | 'heard' | 'engaged' | 'explained' | 'confirmed';

interface DiagramNode {
  id: string;
  label: string;
  description?: string;
  role?: string;
  weight?: number;
  level?: Level;
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

interface ChildrenInfo {
  /** Levels of the first PIP_MAX children, in descending-weight order. */
  visible: (Level | undefined)[];
  /** Total number of direct children (may exceed PIP_MAX). */
  total: number;
  /** How many children are at level=confirmed. Drives the crown. */
  confirmed: number;
}

/** Maximum pips shown below a node before overflowing as "+N". Miller's
 *  law — 5 reads as a glance-count without subitizing failure. */
const PIP_MAX = 5;

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

/** Stable empty-array reference for Zustand selector fallbacks. Using
 *  a `?? []` literal inline causes an infinite render loop because
 *  useSyncExternalStore compares snapshots by reference. */
const EMPTY_STRING_ARRAY: string[] = [];

export function HermesDiagram() {
  const repoPath = useSessionStore(s => s.activeRepoPath);
  const phase = useSessionStore(s => s.state.phase);
  const currentBriefingId = useSessionStore(s => s.currentBriefing?.briefingId ?? null);
  const skillResult = useSessionStore(s => s.skillResult);
  // Karaoke-ball: when a stream chunk is playing, the backend tagged
  // it with diagram-node labels mentioned in its text. These nodes
  // glow during the chunk's audio playback so the user's eye follows
  // the AI's words across the diagram. Computed from the head of the
  // stream queue (currently-playing chunk).
  //
  // CRITICAL: the fallback MUST be a module-level stable reference.
  // `?? []` returns a fresh array literal every render, so the
  // useSyncExternalStore snapshot never `Object.is`-equals itself →
  // infinite re-render loop ("Maximum update depth exceeded"). The
  // non-fallback paths return the chunk's own array, which is a
  // stable reference across renders.
  const currentChunkNodes = useSessionStore(
    s => s.currentStreamChunk?.referencedNodes
       ?? s.streamChunks[0]?.referencedNodes
       ?? EMPTY_STRING_ARRAY,
  );
  // Persistent "touched" set — nodes mentioned in any prior AI reply.
  // The diagram becomes a heat-map of attention as the conversation
  // accumulates: touched nodes get a brighter base color forever after.
  const touchedNodes = useSessionStore(s => s.touchedNodes);

  // Active scope walks the navigator stack — drilling into a module
  // refetches that module's diagram. For now wire to project until the
  // navigator integration lands; the structure is here for it.
  const [scope, setScope] = useState<string>('project');
  const [view, setView] = useState<'logic' | 'file'>('file');
  const [payload, setPayload] = useState<DiagramPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to project when phase resets to IDLE.
  useEffect(() => {
    if (phase === 'IDLE') setScope('project');
  }, [phase]);

  // C1: skill executions with a target node steer the diagram. When a
  // skill (explain, summarize, teach, compare, visualize, critique)
  // returns a visualPayload.target that matches a known module name,
  // drill the diagram there BEFORE the AI starts speaking — so the
  // user has a visual referent for the words they're about to hear
  // ("this module" / "these files" land on the right thing).
  // 200ms framer-motion crossfade is handled by the diagram fetch
  // effect's natural re-render.
  //
  // Dedupe via ref: the effect's deps are [skillResult, payload], but
  // setScope changes the payload (after refetch), which re-runs this
  // effect with the SAME skillResult against the new node set. The
  // fuzzy substring match would then drill again, e.g. "core" → first
  // matches `module/core`, then re-fires and matches `file/core/loader.py`
  // (which also contains the substring "core"). Track the last-acted
  // skillResult reference and only react when it actually changes.
  const knownNodeIds = useMemo(() => new Set(payload?.nodes.map(n => n.id) ?? []), [payload]);
  const lastSteeredSkillResultRef = useRef<unknown>(null);
  useEffect(() => {
    if (!skillResult) return;
    if (lastSteeredSkillResultRef.current === skillResult) return;
    lastSteeredSkillResultRef.current = skillResult;
    const target = (skillResult.visualPayload?.target as string | undefined)?.toLowerCase().trim();
    if (!target) return;
    // Match the skill's free-form target string to a node id. Try
    // direct id, then module/X, then a substring match against any
    // known node label.
    const candidate = `module/${target}`;
    if (knownNodeIds.has(candidate)) {
      setScope(candidate);
      return;
    }
    // Fuzzy: any node id that includes the target word
    for (const id of knownNodeIds) {
      if (id.toLowerCase().includes(target)) {
        setScope(id);
        return;
      }
    }
  }, [skillResult, knownNodeIds]);

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

  // Pre-compute direct-children info for each node: an ordered list of
  // child levels (capped at PIP_MAX, sorted by weight desc) + the total
  // count + how many are confirmed. The list drives the pip row below
  // each node; the totals drive the "+N" overflow indicator and the
  // crown trigger.
  const childrenInfo = useMemo<Map<string, ChildrenInfo>>(() => {
    const out = new Map<string, ChildrenInfo>();
    if (!payload) return out;
    const childrenOf = new Map<string, string[]>();
    for (const e of payload.edges) {
      if (e.kind !== 'contains') continue;
      const list = childrenOf.get(e.from) ?? [];
      list.push(e.to);
      childrenOf.set(e.from, list);
    }
    const byId = new Map(payload.nodes.map(n => [n.id, n]));
    for (const n of payload.nodes) {
      const childIds = childrenOf.get(n.id) ?? [];
      const children = childIds
        .map(id => byId.get(id))
        .filter((c): c is DiagramNode => !!c)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      const total = children.length;
      const visible = children.slice(0, PIP_MAX).map(c => c.level);
      const confirmed = children.filter(c => levelOrdinal(c.level) >= 5).length;
      out.set(n.id, { visible, total, confirmed });
    }
    return out;
  }, [payload]);

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

  // ─── Hierarchical navigation ─────────────────────────────────────
  // The diagram scope has a hierarchy: project → module/X → (later) file/Y.
  // "Back" moves up exactly one level; the breadcrumb's "Project" jumps
  // all the way to the root. Both stay in sync with the backend
  // navigator stack via command:level_up so voice ("go back") and the
  // button hit the same path.
  // IMPORTANT: these hooks live ABOVE the early returns below — Rules of
  // Hooks requires a stable call count across renders. Moving them down
  // changes the hook count between "loading" and "loaded" frames.
  const inSubScope = scope !== 'project';
  // useCallback (not useMemo) for a function reference — useMemo works
  // here but useCallback documents intent and avoids the "function in
  // memo" smell. Closure reads `scope` directly (not the derived
  // `inSubScope`) to be defensive against stale closures on rapid
  // navigations.
  const goBack = useCallback(() => {
    if (scope === 'project') return;
    // Single-level fallback today: any sub-scope (module/X) pops to project.
    // When file-scope drilling lands this becomes module/X → project,
    // file/Y → module/parent — driven by parent pointers in the briefing.
    setScope('project');
    sendEvent({ type: 'command:level_up' });
  }, [scope]);

  // Esc anywhere (outside typing targets) acts as "back". Mirrors voice
  // "go back" and the chevron button so all three paths converge.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      if (t instanceof HTMLElement && t.isContentEditable) return;
      if (!inSubScope) return;
      e.preventDefault();
      goBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inSubScope, goBack]);

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
          <div className="flex items-center justify-between w-full">
            <Breadcrumb
              scope={scope}
              view={view}
              onJumpToProject={() => { setScope('project'); sendEvent({ type: 'command:level_up' }); }}
              onToggleView={() => setView(v => v === 'logic' ? 'file' : 'logic')}
              onBack={goBack}
              canGoBack={inSubScope}
            />
            <KnowledgeStats nodes={payload.nodes} />
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

          {/* Edges first — under nodes.
           *  The center node is intentionally NOT rendered as a pill
           *  (it duplicates the page title — see Nodes section below),
           *  so containment spokes that converge on it would dangle
           *  into empty space. Skip them. Imports and other semantic
           *  edges between satellites stay. */}
          <g>
            {payload.edges.map((edge, i) => {
              const a = nodeById.get(edge.from);
              const b = nodeById.get(edge.to);
              if (!a || !b) return null;
              if (edge.kind === 'contains' && (a.isCenter || b.isCenter)) return null;
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

          {/* Time slider mounted as a sibling of the SVG below */}
          {/* Nodes — skip the center entirely. The center node's label
           *  is always the current scope (e.g., "PersonalForge" for the
           *  project view), which already appears in the title bar
           *  directly above the canvas. Rendering it again as a big
           *  pill duplicates the page title for no gain AND it was
           *  the only non-interactive pill in the diagram, which read
           *  as a broken-looking affordance. The satellites stand
           *  alone now; the radial layout still orbits the same
           *  invisible center coordinate so spacing/positioning is
           *  unchanged. */}
          <g>
            {positioned.filter(n => !n.isCenter).map(n => (
              <DiagramNodeView
                key={n.id}
                node={n}
                active={n.briefingId !== null && n.briefingId === currentBriefingId}
                anchorPulse={isAnchorMatch(n, currentChunkNodes)}
                touched={isTouched(n, touchedNodes)}
                childrenInfo={childrenInfo.get(n.id) ?? null}
                onClick={() => onNodeClick(n)}
              />
            ))}
          </g>
        </svg>
        {/* Time slider — bottom of canvas. Scrubs through turn snapshots
         *  so the user can rehydrate any prior moment in the conversation.
         *  Hidden until there are 2+ turns. */}
        <TimeSlider onRehydrateScope={(s) => setScope(s)} />
        </div>
      </div>
    </div>
  );
}

/** Returns true if this node's id or label matches any anchor token
 *  the backend tagged the currently-playing chunk with. The chunker
 *  matches against module display names; we test both the satellite's
 *  label and the module-id-without-prefix so "core" and "module/core"
 *  both work. */
function isAnchorMatch(node: PositionedNode, anchors: string[]): boolean {
  if (anchors.length === 0) return false;
  const normalized = anchors.map(a => a.toLowerCase());
  const idWithoutPrefix = node.id.replace(/^(module|file|concept)\//, '').toLowerCase();
  const label = node.label.toLowerCase();
  return normalized.includes(idWithoutPrefix) || normalized.includes(label);
}

/** Persistent-halo membership check — node was referenced in any
 *  prior AI reply this session. */
function isTouched(node: PositionedNode, touched: Set<string>): boolean {
  if (touched.size === 0) return false;
  const idWithoutPrefix = node.id.replace(/^(module|file|concept)\//, '');
  for (const t of touched) {
    if (t === node.id || t === idWithoutPrefix || t.toLowerCase() === node.label.toLowerCase()) return true;
  }
  return false;
}

interface NodeViewProps {
  node: PositionedNode;
  active: boolean;
  anchorPulse?: boolean;
  touched?: boolean;
  childrenInfo: ChildrenInfo | null;
  onClick: () => void;
}

function DiagramNodeView({ node, active, anchorPulse, touched, childrenInfo, onClick }: NodeViewProps) {
  const [hover, setHover] = useState(false);
  // Own-layer comprehension drives the BATTERY FILL of the node body.
  // The whole shape changes with knowledge — `unknown` is an empty
  // outline, `confirmed` is fully warm gold. The peripheral bar +
  // halo treatment never read intuitively; the body fill makes the
  // signal impossible to miss.
  const ownLevel: Level | undefined = node.level;
  const ownOrdinal = levelOrdinal(ownLevel);  // 0..5
  const ownFraction = ownOrdinal / 5;
  const ownColor = levelColor(ownLevel);
  // Per-node gradient id — must be unique per node so each node's fill
  // line lands at its own ownFraction. SVG gradients are referenced by
  // id; collision would make every node share one fill height.
  const gradId = `hd-fill-${nodeIdToSafeCssId(node.id)}`;
  // Title size tracks node size — center has the biggest type. The
  // satellite size was bumped from 14→17 because file-scope drill views
  // (n=5+ filename satellites) were unreadable at the default zoom.
  const titleSize = node.isCenter ? 24 : 17;
  const subSize = node.isCenter ? 13 : 12;
  const lineHeight = subSize * 1.4;

  // Crown ★ — fires when both own=confirmed AND every visible child pip
  // is confirmed (i.e., what the user can SEE on this node is fully
  // known). Doesn't require transitive completeness, just the visible
  // set. The reward is glance-readable: a node is "done" when crowned.
  const visibleChildrenAllConfirmed =
    !!childrenInfo &&
    childrenInfo.visible.length > 0 &&
    childrenInfo.visible.every(l => levelOrdinal(l) >= 5);
  const ownConfirmed = ownOrdinal >= 5;
  const showCrown = ownConfirmed && (childrenInfo?.visible.length === 0 || visibleChildrenAllConfirmed);

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
  // Allow up to 4 lines for the center node (more legroom) and 3 for
  // satellites. The user's complaint was subtitles being cut off with
  // ellipses; with oneLineDescription bounded to ~200 chars upstream,
  // 3-4 wrapped lines comfortably fit the full sentence.
  const maxLines = node.isCenter ? 4 : 3;
  const lines = node.description
    ? wrapForRect(node.description, innerWidth, subSize, maxLines)
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
      {/* Per-node battery-fill gradient. Hard color stops at the
       *  own-knowledge level create a "fill line" — below = warm
       *  comprehension color, above = dim base. y1=1, y2=0 makes the
       *  gradient flow bottom→top so fill rises like a battery. */}
      <defs>
        <linearGradient id={gradId} x1="0" y1="1" x2="0" y2="0">
          {ownOrdinal === 0 ? (
            <>
              <stop offset="0" stopColor="oklch(0.18 0.012 60)" />
              <stop offset="1" stopColor="oklch(0.14 0.008 60)" />
            </>
          ) : (
            <>
              <stop offset="0" stopColor={ownColor ?? 'oklch(0.5 0.07 60)'} stopOpacity="0.85" />
              <stop offset={String(ownFraction)} stopColor={ownColor ?? 'oklch(0.5 0.07 60)'} stopOpacity="0.55" />
              <stop offset={String(ownFraction)} stopColor="oklch(0.20 0.014 60)" stopOpacity="0.95" />
              <stop offset="1" stopColor="oklch(0.16 0.010 60)" stopOpacity="0.95" />
            </>
          )}
        </linearGradient>
      </defs>
      {/* Pulse ring — only for the active (currently-narrated) node.
       *  Distinct from any comprehension signal: a slow steady pulse
       *  always means "Hermes is talking about this right now (whole
       *  conversation context)". */}
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
      {/* Anchor pulse — fires when the CURRENT chunk's text mentions
       *  this node by name. Sharper, faster animation than the focus
       *  pulse (1s vs 2.4s) — visually reads as "the AI is saying
       *  THIS WORD right now", a karaoke-ball effect across the
       *  diagram. Stops when the next chunk arrives without this
       *  node in its anchors. Coexists with the focus pulse (different
       *  cadence, different color so they don't visually fight). */}
      {anchorPulse && !active && (
        <circle
          r={node.radius + 6}
          fill="none"
          stroke="oklch(0.86 0.18 95)"
          strokeWidth={2.5}
          opacity={0.85}
        >
          <animate attributeName="r" values={`${node.radius + 4};${node.radius + 14};${node.radius + 4}`} dur="1s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.95;0.35;0.95" dur="1s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Frontier pulse — very subtle slow glow on nodes the user
       *  has heard about but not yet engaged with. The "one ask away
       *  from explained" affordance: signals where the natural next
       *  question lies. Off when the node is also active or anchor-
       *  pulsing (those signals are stronger and shouldn't fight). */}
      {!active && !anchorPulse && node.level === 'heard' && (
        <circle
          r={node.radius + 3}
          fill="none"
          stroke="oklch(0.55 0.07 60)"
          strokeWidth={1}
          opacity={0.35}
        >
          <animate attributeName="opacity" values="0.15;0.45;0.15" dur="3.6s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Node body — pill (rounded rect). Fill comes from the per-node
       *  battery gradient so the body itself carries the own-knowledge
       *  signal. No halo (was the children-rollup before; that role
       *  moved to the pip row below).
       *
       *  When `touched` (this node was referenced in any prior AI reply
       *  this session), the stroke shifts to a brighter warm tone —
       *  the diagram gradually warms up where the conversation has
       *  been. Persistent across the session. The "heat-map of your
       *  attention" effect from the design jam. */}
      <rect
        x={-rectWidth / 2}
        y={-rectHeight / 2}
        width={rectWidth}
        height={rectHeight}
        rx={14}
        ry={14}
        fill={`url(#${gradId})`}
        stroke={
          hover
            ? 'oklch(0.55 0.10 70)'
            : ownConfirmed
              ? 'oklch(0.62 0.10 75)'
              : touched
                ? 'oklch(0.55 0.08 75)'
                : 'oklch(0.40 0.03 70)'
        }
        strokeWidth={hover ? 1.5 : touched ? 1.25 : 1}
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
      {/* Pip row — one dot per direct child, capped at PIP_MAX, colored
       *  by that child's comprehension level. Reads as a scoreboard:
       *  glance to see how many sub-things you know. "+N" suffix when
       *  there are more children than pips. Stays below the node so it
       *  doesn't compete with the body fill for visual real estate. */}
      {childrenInfo && childrenInfo.visible.length > 0 && (() => {
        const pipR = 4;
        const pipGap = 10;
        const overflow = childrenInfo.total - childrenInfo.visible.length;
        const overflowExtra = overflow > 0 ? 22 : 0; // room for "+N"
        const rowWidth = childrenInfo.visible.length * (pipR * 2) + (childrenInfo.visible.length - 1) * pipGap + overflowExtra;
        const startX = -rowWidth / 2 + pipR;
        const rowY = rectHeight / 2 + 14;
        return (
          <g data-testid={`hd-pips-${node.id}`}>
            {childrenInfo.visible.map((lvl, i) => {
              const ord = levelOrdinal(lvl);
              const col = levelColor(lvl) ?? 'oklch(0.30 0.015 65)';
              return (
                <circle
                  key={i}
                  cx={startX + i * (pipR * 2 + pipGap)}
                  cy={rowY}
                  r={pipR}
                  fill={ord >= 1 ? col : 'oklch(0.22 0.012 65)'}
                  stroke={ord >= 1 ? col : 'oklch(0.32 0.020 65)'}
                  strokeWidth={1}
                  opacity={ord >= 1 ? 0.95 : 0.6}
                />
              );
            })}
            {overflow > 0 && (
              <text
                x={startX + childrenInfo.visible.length * (pipR * 2 + pipGap)}
                y={rowY + 0.5}
                dominantBaseline="middle"
                style={{
                  fontFamily: 'var(--mono, "Geist Mono", ui-monospace, monospace)',
                  fontSize: 10,
                  fill: 'var(--cream-500, #b8a99a)',
                  opacity: 0.7,
                }}
              >
                +{overflow}
              </text>
            )}
          </g>
        );
      })()}
      {/* Crown ★ — small mark above the title when the user has
       *  confirmed this node AND every visible child. The "done"
       *  beat — borrowed from Duolingo / skill-tree mastery icons. */}
      {showCrown && (
        <text
          textAnchor="middle"
          x={0}
          y={-rectHeight / 2 - 10}
          style={{
            fontSize: 14,
            fill: 'oklch(0.85 0.18 90)',
            filter: 'drop-shadow(0 0 6px oklch(0.78 0.16 90 / 0.6))',
          }}
          aria-label="Mastered"
        >
          ★
        </text>
      )}
    </g>
  );
}

/** Strip characters that aren't safe in an SVG id (`/`, etc.). Some
 *  node ids look like `module/core` or `file/core/loader.py` — those
 *  break gradient lookups via `url(#id)` if used raw. */
function nodeIdToSafeCssId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function levelOrdinal(l: Level | undefined): number {
  switch (l) {
    case 'confirmed': return 5;
    case 'explained': return 4;
    case 'engaged':   return 3;
    case 'heard':     return 2;
    case 'mentioned': return 1;
    default:          return 0;
  }
}

function ordinalToLevel(o: number): Level | undefined {
  if (o <= 0) return undefined;
  if (o >= 5) return 'confirmed';
  return (['mentioned', 'heard', 'engaged', 'explained'][o - 1] as Level) ?? undefined;
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
  // No ellipsis on overflow. oneLineDescription upstream caps input at
  // ~200 chars, which fits comfortably in 3-4 wrapped lines at the node
  // sizes we render. If the cap is ever lifted, the visual will simply
  // hard-cut at the last full word — the trailing "…" was the specific
  // visual the user asked us to remove.
  return lines;
}

// ─────────────────────────────────────────────────────────────────────
// Breadcrumb
// ─────────────────────────────────────────────────────────────────────

interface BreadcrumbProps {
  scope: string;
  view: 'logic' | 'file';
  onJumpToProject: () => void;
  onToggleView: () => void;
  onBack: () => void;
  canGoBack: boolean;
}

/** Hierarchical breadcrumb. Every segment is clickable: Project jumps to
 *  the root; module name re-centers the current scope (a no-op today but
 *  reserved for refresh / file-scope drill); view label toggles between
 *  Logic flow and File map. A persistent "← Back" chevron on the left
 *  pops one level — works at any scope, mirrors the Esc keybind and the
 *  voice phrase "go back". */
function Breadcrumb({ scope, view, onJumpToProject, onToggleView, onBack, canGoBack }: BreadcrumbProps) {
  const moduleName = scope.startsWith('module/') ? scope.slice('module/'.length) : null;
  return (
    <nav
      className="font-mono flex items-center gap-1"
      style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--cream-500)', opacity: 0.92 }}
      aria-label="Diagram navigation"
    >
      {/* Show the Back button only when there's somewhere to go back to.
       *  Greying it out at the project root was confusing — the user
       *  read "doesn't respond to clicks" as a broken button rather than
       *  "you're already at the top." Hiding makes the affordance honest. */}
      {canGoBack && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onBack(); }}
            title="Go back one level (Esc)"
            aria-label="Go back one level"
            className="font-mono"
            style={{
              padding: '3px 9px',
              borderRadius: 999,
              background: 'oklch(1 0 0 / 0.05)',
              border: '1px solid oklch(1 0 0 / 0.10)',
              color: 'var(--cream-300)',
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
            data-testid="hermes-diagram-back"
          >
            ← Back
          </button>
          <CrumbSeparator />
        </>
      )}

      <CrumbButton
        onClick={onJumpToProject}
        active={!moduleName}
        title="Jump to the project view"
        testid="crumb-project"
      >
        Project
      </CrumbButton>

      {moduleName && (
        <>
          <CrumbSeparator />
          <span style={{ color: 'var(--cream-500)' }}>Module</span>
          <CrumbSeparator dot />
          <CrumbButton
            onClick={() => { /* already on this module — no-op for now */ }}
            active
            title={`Currently viewing module: ${moduleName}`}
            testid="crumb-module"
          >
            {moduleName}
          </CrumbButton>
        </>
      )}

      <CrumbSeparator />

      <CrumbButton
        onClick={onToggleView}
        active={false}
        title={`Switch to ${view === 'logic' ? 'File map' : 'Logic flow'}`}
        testid="crumb-view-toggle"
      >
        {view === 'logic' ? 'Logic flow' : 'File map'} ⇄
      </CrumbButton>
    </nav>
  );
}

function CrumbSeparator({ dot }: { dot?: boolean }) {
  return (
    <span aria-hidden style={{ color: 'var(--cream-500)', opacity: 0.45, padding: '0 2px' }}>
      {dot ? '·' : '›'}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Knowledge stats strip
// ─────────────────────────────────────────────────────────────────────

/** Compact knowledge summary that lives on the right side of the
 *  breadcrumb row. Counts nodes by comprehension level so the user gets
 *  an at-a-glance answer to "how much of this view do I actually know?"
 *  Pairs with the per-node progress bar (own knowledge) and the halo
 *  (children rollup) to form the knowledge-map signal stack. */
function KnowledgeStats({ nodes }: { nodes: DiagramNode[] }) {
  const buckets = useMemo(() => {
    const cold = nodes.filter(n => levelOrdinal(n.level) <= 0).length;
    const warm = nodes.filter(n => {
      const o = levelOrdinal(n.level);
      return o >= 1 && o <= 3;
    }).length;
    const known = nodes.filter(n => levelOrdinal(n.level) >= 4).length;
    return { cold, warm, known, total: nodes.length };
  }, [nodes]);

  if (buckets.total === 0) return null;
  const knownPct = Math.round((buckets.known / buckets.total) * 100);

  return (
    <div
      className="font-mono flex items-center gap-3"
      style={{ fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--cream-500)', opacity: 0.85 }}
      title="Comprehension across the visible nodes"
      aria-label="Knowledge stats"
      data-testid="hermes-diagram-stats"
    >
      <Pip color={levelColor('confirmed')!} count={buckets.known} label="known" />
      <Pip color={levelColor('heard')!}     count={buckets.warm}  label="heard" />
      <Pip color="oklch(0.40 0.02 70)"       count={buckets.cold}  label="cold" />
      <span style={{ opacity: 0.6 }}>·</span>
      <span style={{ color: 'var(--cream-300)' }}>{knownPct}%</span>
    </div>
  );
}

function Pip({ color, count, label }: { color: string; count: number; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%',
        background: color, boxShadow: `0 0 4px ${color}`, opacity: count > 0 ? 1 : 0.35,
      }} />
      <span style={{ color: count > 0 ? 'var(--cream-400)' : 'var(--cream-500)' }}>{count} {label}</span>
    </span>
  );
}

function CrumbButton({
  children, onClick, active, title, testid,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active: boolean;
  title: string;
  testid: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      data-testid={testid}
      className="font-mono"
      style={{
        background: 'transparent',
        border: 'none',
        padding: '2px 4px',
        color: active ? 'var(--cream-200)' : 'var(--cream-500)',
        fontSize: 11,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        opacity: active ? 1 : 0.85,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--cream-100)')}
      onMouseLeave={(e) => (e.currentTarget.style.color = active ? 'var(--cream-200)' : 'var(--cream-500)')}
    >
      {children}
    </button>
  );
}
