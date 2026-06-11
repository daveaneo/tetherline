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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSessionStore } from '../../state/session-store.js';
import { useAudioStore } from '../../state/audio-store.js';
import { TimeSlider } from './TimeSlider.js';
import { heatmapOverlayActive } from './heatmap-overlay.js';
import { concernNodeIds, isConcernActive, activeConcernText } from './concern-tint.js';
import { Breadcrumb as PositionTrail } from './Breadcrumb.js';
import { grillScreenActive } from './grill-screen.js';
import { GrillScreen } from './GrillScreen.js';
import { DeepDivePocket, type PocketSlide } from './DeepDivePocket.js';
import { pipelineRevealOrder } from './pipeline-reveal.js';
import { blastRadiusRings } from './blast-radius.js';
import {
  levelOrdinal,
  knowledgeRollUp,
  containsAdjacency,
  changeHeatByNode,
  type KnowledgeRoll,
} from '@tetherline/shared';
import { levelColor } from './level-color.js';
import { annotationToShelfArtifact, pinnedNodeIds } from './annotate-shelf.js';
import { issueResultToShelfArtifact } from './issue-shelf.js';
import { useShelfStore } from '../../state/shelf-store.js';
import { motion } from 'framer-motion';
import { motionVariantFor, scopeTransition, prefersReducedMotion } from './transition-motion.js';
import { sendEvent } from '../../lib/ws-client.js';
import { API_PREFIX } from '@tetherline/shared';
import type { Level, DiagramNode, DiagramEdge, DiagramPayload } from './diagram-types.js';
import { layeredPositions, edgeKey } from './layered-layout.js';

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
// Uniform pill radius for layered (pipeline/sequence) flow nodes.
const LAYERED_RADIUS = 62;

/** Stable empty-array reference for Zustand selector fallbacks. Using
 *  a `?? []` literal inline causes an infinite render loop because
 *  useSyncExternalStore compares snapshots by reference. */
const EMPTY_STRING_ARRAY: string[] = [];

export function HermesDiagram() {
  const repoPath = useSessionStore(s => s.activeRepoPath);
  const phase = useSessionStore(s => s.state.phase);
  const currentBriefingId = useSessionStore(s => s.currentBriefing?.briefingId ?? null);
  const skillResult = useSessionStore(s => s.skillResult);
  const critiqueActiveIndex = useSessionStore(s => s.critiqueActiveIndex);
  const heatmapData = useSessionStore(s => s.heatmap);
  const breadcrumbPocket = useSessionStore(s => s.breadcrumbPocket);
  const pipelineReveal = useSessionStore(s => s.pipelineReveal);
  const blastRadius = useSessionStore(s => s.blastRadius);
  const guidedTour = useSessionStore(s => s.guidedTour);
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

  // Normalize the chunk anchors ONCE per chunk, not once per node per
  // render — with the memoized DiagramNodeView this is the only
  // per-chunk work the node layer pays.
  const anchorSet = useMemo(() => {
    const s = new Set<string>();
    for (const a of currentChunkNodes) s.add(a.toLowerCase());
    return s;
  }, [currentChunkNodes]);

  // Active scope walks the navigator stack — drilling into a module
  // refetches that module's diagram. For now wire to project until the
  // navigator integration lands; the structure is here for it.
  const [scope, setScope] = useState<string>('project');
  const [view, setView] = useState<'logic' | 'file'>('file');

  // Compact (phone-width) rendering: node subtitles and the S/Q meta
  // bars rasterize at ~6px when the 1200-unit viewBox squeezes into a
  // 390px viewport — illegible noise. Compact mode drops them so the
  // node titles get the pixels instead.
  const [compact, setCompact] = useState<boolean>(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = () => setCompact(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Transition-grammar motion (B2): the relationship between the
  // previous and current scope decides the motion the node layer
  // plays, so the animation itself encodes the navigational move.
  // Keyed remount on scope drives the enter animation.
  const prevScopeRef = useRef<string | null>(null);
  // Derive only (no mutation) so React StrictMode's double-invoke of
  // useMemo can't collapse the transition to IN_PLACE. The ref is
  // advanced in a post-commit effect, exactly once per real change.
  const scopeMotion = useMemo(
    () => motionVariantFor(scopeTransition(prevScopeRef.current, scope), prefersReducedMotion()),
    [scope],
  );
  useEffect(() => {
    prevScopeRef.current = scope;
  }, [scope]);

  const [fetchedPayload, setFetchedPayload] = useState<DiagramPayload | null>(null);
  // When `visualize` skill returns an authored diagram, swap it in
  // for the lifetime of the result so the words and the picture
  // agree. Cached payload is preserved (not refetched) and restored
  // when the skill clears.
  const authoredPayload = useMemo(() => {
    if (skillResult?.skillName !== 'visualize') return null;
    const d = (skillResult.visualPayload as { diagram?: DiagramPayload } | undefined)?.diagram;
    return d && Array.isArray(d.nodes) && d.nodes.length > 0 ? d : null;
  }, [skillResult]);
  const payload = authoredPayload ?? fetchedPayload;
  // Authored pipeline/sequence diagrams lay out left→right (staged flow);
  // graph/tree and every cached scope keep the radial layout. The kind hint
  // rode along unused until now (visualize.ts authored it, radial ignored it).
  const authoredKind = authoredPayload
    ? (skillResult?.visualPayload as { kind?: string } | undefined)?.kind ?? null
    : null;
  const layered = authoredKind === 'pipeline' || authoredKind === 'sequence';
  const layeredLayout = useMemo(
    () => (layered && payload ? layeredPositions(payload.nodes, payload.edges, { width: VIEWBOX_W, height: VIEWBOX_H }) : null),
    [layered, payload],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Anti-hang (#73): the diagram must NEVER show "Composing…" forever.
  // If no payload arrives within a grace window (e.g. the resume WS
  // errored and activeRepoPath never populated), surface a recoverable
  // state instead of an eternal spinner. `retryNonce` re-triggers the
  // fetch effect.
  const [stalled, setStalled] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // Annotate → Notebook (B10): an annotate result drops a row in the
  // shelf's notes section. Deduped by skillResult identity (the same
  // ref pattern the steer effect uses) so it appends exactly once.
  const lastAnnotatedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!skillResult || lastAnnotatedRef.current === skillResult) return;
    const art = annotationToShelfArtifact(skillResult, `note-${Date.now()}`);
    if (art) {
      lastAnnotatedRef.current = skillResult;
      useShelfStore.getState().append(art);
    }
  }, [skillResult]);

  // B18: a create_issue result drops a read-only row in the shelf's
  // issues section (local register; tracker-agnostic). Same
  // dedupe-by-identity pattern as the annotate effect above.
  const lastIssuedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!skillResult || lastIssuedRef.current === skillResult) return;
    const issueArt = issueResultToShelfArtifact(skillResult, `issue-${Date.now()}`);
    if (issueArt) {
      lastIssuedRef.current = skillResult;
      useShelfStore.getState().append(issueArt);
    }
  }, [skillResult]);

  // `visualize` skill → auto-switch to LOGIC view. The skill's
  // narration talks about ideas / pipelines / structures; if the
  // user is in File-map view they'd see files and the words don't
  // match the picture (the "saw files instead of ideas/structures"
  // bug). Switching the view makes the visual back up the words.
  // Deduped by skillResult identity so we don't fight a manual flip.
  const lastVisualizedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!skillResult || skillResult.skillName !== 'visualize') return;
    if (lastVisualizedRef.current === skillResult) return;
    lastVisualizedRef.current = skillResult;
    setView('logic');
    // Keep the breadcrumb honest: a surfaced module flow (scope
    // flow/module/<X>) must read as that module, not whatever scope the user
    // last navigated to (live desync: "[crumb] colab" while viewing core's
    // flow, 2026-06-10). Derive the module crumb from the authored scope.
    const flowScope = (skillResult.visualPayload as { diagram?: { scope?: string } } | undefined)?.diagram?.scope;
    const m = /^flow\/(module\/[\w./-]+)$/.exec(flowScope ?? '');
    if (m) setScope(m[1]);
  }, [skillResult]);

  // Persistent pins (B10): nodes whose leaf/label matches a Notebook
  // entry's target. Derived from the shelf notes — survives sessions
  // once those are seeded.
  const noteArtifacts = useShelfStore(s => s.artifacts.notes);
  const pinnedIds = useMemo(() => {
    const targets = noteArtifacts
      .map(a => a.nodeId || a.summary)
      .filter((t): t is string => !!t);
    return pinnedNodeIds(targets, (payload?.nodes ?? []).map(n => ({ id: n.id, label: n.label })));
  }, [noteArtifacts, payload]);

  // Critique concern tint (B5): only the ACTIVE concern's nodes get a
  // worry tint. For a ranked critique that's the selected concern's
  // explicit targets (the ring moves as you step through concerns);
  // legacy/fallback prose degrades to narration string-match. Derived
  // text-side so the visual can't disagree with the audio. Additive.
  const concernIds = useMemo(() => {
    if (!isConcernActive(skillResult)) return new Set<string>();
    const text = activeConcernText(skillResult, critiqueActiveIndex);
    if (!text) return new Set<string>();
    return new Set(
      concernNodeIds(text, (payload?.nodes ?? []).map(n => ({ id: n.id, label: n.label }))),
    );
  }, [skillResult, critiqueActiveIndex, payload]);

  // Guided tour (B15): connect the header spine to the canvas. The
  // node matching the CURRENT step's name gets a "you are here" amber
  // halo, so the spine ("step 3/5 · Frontend") and the diagram agree.
  // Deterministic label match (same idea as the concern tint).
  const guidedFocusId = useMemo(() => {
    if (!guidedTour || !payload) return null;
    const cur = guidedTour.items[guidedTour.currentIndex];
    if (!cur) return null;
    const want = cur.name.trim().toLowerCase();
    const hit = (payload.nodes ?? []).find(
      n => (n.label ?? '').trim().toLowerCase() === want,
    );
    return hit?.id ?? null;
  }, [guidedTour, payload]);

  // Reset to project when phase resets to IDLE.
  useEffect(() => {
    if (phase === 'IDLE') setScope('project');
  }, [phase]);

  // Visual dispatch (the single sink): the backend resolves every
  // answered turn — Q&A, skills, voice nav verbs — through
  // dispatchVisual and emits ONE visual:dispatch event. The diagram
  // applies it here: DESCEND/LATERAL drill the scope, ASCEND climbs,
  // IN_PLACE pulses the refs. This replaced the old C1 substring-steer
  // effect (which only fired for skills and could double-drill).
  const visualDispatch = useSessionStore(s => s.visualDispatch);
  const [dispatchPulseIds, setDispatchPulseIds] = useState<Set<string>>(() => new Set());
  // Two-stage acknowledgment: a strong 3s attack pulse, then a STATIC
  // "we're talking about THIS" ring that persists until the NEXT
  // dispatch. The old 6s subtle pulse registered as nothing — a full
  // live session read as "the screen never changed".
  const [dispatchSettled, setDispatchSettled] = useState(true);
  const lastDispatchTsRef = useRef<number>(0);
  useEffect(() => {
    if (!visualDispatch || visualDispatch.ts === lastDispatchTsRef.current) return;
    lastDispatchTsRef.current = visualDispatch.ts;
    const { transition, targetNodeId, refs } = visualDispatch;
    if ((transition === 'DESCEND' || transition === 'LATERAL') && targetNodeId?.startsWith('module/')) {
      setScope(targetNodeId);
    } else if (transition === 'ASCEND') {
      setScope(targetNodeId && targetNodeId.startsWith('module/') ? targetNodeId : 'project');
    }
    // Acknowledgment ring on the subject + refs — persists until the next
    // answer replaces it, even when nothing matched (center ring).
    const pulse = new Set<string>(refs);
    if (targetNodeId) pulse.add(targetNodeId);
    setDispatchPulseIds(pulse);
    // Age-derived settling: scene seeds use an old ts and render the
    // deterministic static ring (no SMIL → pixel-diff stable).
    const age = Date.now() - visualDispatch.ts;
    if (age >= 3000) {
      setDispatchSettled(true);
      return;
    }
    setDispatchSettled(false);
    const t = setTimeout(() => setDispatchSettled(true), 3000 - age);
    return () => clearTimeout(t);
  }, [visualDispatch]);

  // Mirror the local scope to the backend so the dispatcher classifies
  // DESCEND vs ASCEND against what the user actually sees. Single effect
  // catches every setScope caller (click, Esc, TimeSlider, dispatch).
  useEffect(() => {
    if (phase === 'IDLE') return;
    sendEvent({ type: 'diagram:scope', payload: { scope } });
  }, [scope, phase]);

  // Bounded wait: once a session is active, the diagram has a grace
  // window to appear. If it doesn't (missing repoPath from a failed
  // resume WS, or a hung fetch), flip to a recoverable "stalled"
  // state rather than an eternal "Composing…". Cleared as soon as a
  // payload or error lands.
  useEffect(() => {
    // Two stall cases: never had a payload (cold session), or a
    // REVALIDATION hangs (SWR keeps the old canvas up while loading —
    // without this arm, a hung drill-down dimmed the canvas forever).
    const settled = payload ? !loading : false;
    if (phase === 'IDLE' || error || settled) { setStalled(false); return; }
    const t = setTimeout(() => setStalled(true), 12000);
    return () => clearTimeout(t);
  }, [phase, payload, loading, error, repoPath, retryNonce]);

  // Fetch the diagram payload whenever scope/view/repoPath changes.
  useEffect(() => {
    // DEV scene harness: a seeded payload renders deterministically
    // with NO fetch, NO WS, NO backend. Production never sets this.
    const scenePayload = useSessionStore.getState().sceneDiagramPayload;
    if (scenePayload) {
      setFetchedPayload(scenePayload);
      setLoading(false);
      setError(null);
      setStalled(false);
      return;
    }
    if (!repoPath || phase === 'IDLE') return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStalled(false);
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
        setFetchedPayload(j.diagram);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [repoPath, scope, view, phase, retryNonce]);

  const retryDiagram = useCallback(() => {
    setError(null);
    setStalled(false);
    setRetryNonce(n => n + 1);
  }, []);

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
      // Authored flow stages contain FILES (no 'contains' edges) — show a
      // "contains N" pip from implementsFiles so the user sees what lives
      // inside a stage ("are those inside these five?", live 2026-06-10).
      if (layered && n.implementsFiles && n.implementsFiles.length > 0) {
        const files = n.implementsFiles;
        out.set(n.id, { visible: files.slice(0, PIP_MAX).map(() => undefined), total: files.length });
        continue;
      }
      const childIds = childrenOf.get(n.id) ?? [];
      const children = childIds
        .map(id => byId.get(id))
        .filter((c): c is DiagramNode => !!c)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      const total = children.length;
      const visible = children.slice(0, PIP_MAX).map(c => c.level);
      out.set(n.id, { visible, total });
    }
    return out;
  }, [payload, layered]);

  const positioned = useMemo<PositionedNode[]>(() => {
    if (!payload) return [];
    const nodes = payload.nodes;
    if (nodes.length === 0) return [];
    // Layered authored flow: every node is a real stage (no invisible center),
    // positioned by topological column from the pure layout engine.
    if (layeredLayout) {
      return nodes.map(n => {
        const p = layeredLayout.positions.get(n.id);
        return {
          ...n,
          x: p?.x ?? CENTER_X,
          y: p?.y ?? CENTER_Y,
          radius: LAYERED_RADIUS,
          isCenter: false,
        };
      });
    }
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
  }, [payload, layeredLayout]);

  const nodeById = useMemo(() => new Map(positioned.map(n => [n.id, n])), [positioned]);

  // Pipeline walkthrough (B3): derive the reveal order from the cached
  // graph via the tested ordering core, then dim every node past the
  // current step so the flow lights up source→…→sink one stage at a
  // time. Reuses pipelineRevealOrder verbatim — no reordering here.
  const pipeline = useMemo(() => {
    if (!pipelineReveal || !payload) return null;
    const order = pipelineRevealOrder(
      payload.nodes.map(n => ({ id: n.id, data: { role: n.role } })),
    );
    const total = order.length;
    const step = Math.max(1, Math.min(pipelineReveal.step, total));
    const revealed = new Set(order.slice(0, step).map(o => o.id));
    const r = (order[step - 1]?.data as { role?: string } | undefined)?.role;
    const currentRole =
      r === 'source' || r === 'transform' || r === 'guard' || r === 'sink' ? r : null;
    return { step, total, revealed, currentRole };
  }, [pipelineReveal, payload]);

  // Blast-radius ripple (B4): BFS the import graph from the changed
  // node via the tested blastRadiusRings core; map each node to its
  // shortest hop distance so the renderer can fade rings outward.
  const blast = useMemo(() => {
    if (!blastRadius || !payload) return null;
    const importEdges = payload.edges
      .filter(e => e.kind === 'imports')
      .map(e => ({ source: e.from, target: e.to }));
    const rings = blastRadiusRings(blastRadius.changedId, importEdges);
    const hopOf = new Map<string, number>();
    rings.forEach((ring, hop) => ring.forEach(id => hopOf.set(id, hop)));
    return { hopOf, rings: rings.length, changedId: blastRadius.changedId };
  }, [blastRadius, payload]);

  // v3 knowledge roll-up over the contains-hierarchy: per node
  // {seenPct, testedSummary, ownBest, …}. Components show subtree
  // SUMMARIES; the title (scope node) shows deep Seen + its OWN best
  // test. Single shared scoring core.
  const scores = useMemo(() => {
    if (!payload) return null;
    const byId = new Map(
      payload.nodes.map(n => [n.id, {
        level: n.level, grilled: n.grilled, seen: n.seen,
        quizCorrect: n.quizCorrect, quizTotal: n.quizTotal,
        grillStrong: n.grillStrong, grillAsked: n.grillAsked,
      }]),
    );
    return knowledgeRollUp(byId, containsAdjacency(payload.edges));
  }, [payload]);

  // whats_changed heat: per-node "how much moved this week" from the
  // git heatmap the backend pushes via session:heatmap. Only computed
  // while the whats_changed overlay is active (project scope); null
  // otherwise so the overlay is inert. Shared pure mapper.
  const heatByNode = useMemo(() => {
    if (!payload || !heatmapOverlayActive(skillResult, scope)) return null;
    return changeHeatByNode(payload.nodes.map(n => n.id), heatmapData?.entries ?? []);
  }, [payload, heatmapData, skillResult, scope]);

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

  // Node click — stable identity (useCallback) so the memoized
  // DiagramNodeView doesn't re-render every node on every stream chunk.
  // Lives ABOVE the early returns (Rules of Hooks).
  const onNodeClick = useCallback((n: PositionedNode) => {
    if (n.isCenter) return; // don't drill on the center
    const utterance = `tell me about ${prettyLabel(n)}`;
    // Send first — a dropped send must not show "thinking" for a reply
    // that will never come (disconnected socket drops events).
    if (!sendEvent({ type: 'user:utterance', payload: { text: utterance, timestamp: Date.now() } })) {
      useAudioStore.getState().addSpeechToast('Not connected — try again in a moment.', 'error');
      return;
    }
    useSessionStore.getState().addConversation('you', utterance);
    useAudioStore.getState().setVoiceState('processing');
    // Drill — switch the cached scope to that node.
    if (n.id.startsWith('module/')) setScope(n.id);
  }, []);

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
  // Recoverable failure / stall — NEVER an eternal spinner (#73).
  if ((error || stalled) && !payload) {
    return (
      <div className="flex flex-col items-center justify-center h-full" style={{ gap: 14, color: 'var(--cream-500)' }}>
        <div className="font-mono" style={{ fontSize: 11, letterSpacing: '0.16em', textTransform: 'uppercase', opacity: 0.8 }}>
          {error ? `Couldn't load the diagram: ${error}` : "Diagram didn't load — the session may not have connected."}
        </div>
        <button
          type="button"
          onClick={retryDiagram}
          className="font-mono"
          style={{
            fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase',
            padding: '7px 16px', borderRadius: 6, cursor: 'pointer',
            background: 'oklch(0.74 0.12 65 / 0.18)', color: 'var(--amber-400, oklch(0.74 0.12 65))',
            border: '1px solid oklch(0.74 0.12 65 / 0.4)',
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  // Stale-while-revalidate: the placeholder only shows when there is
  // truly NOTHING to draw. Every drill-down / Back / Logic⇄File toggle
  // used to blank the whole canvas to this text line for the fetch
  // round-trip — the previous payload stays up (dimmed, with an
  // "updating…" chip) instead.
  if (!payload) {
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

  // grill_me REPLACES the diagram with the calm `?` mode screen
  // (design intent). Early return → full-bleed, no diagram peek / no
  // dead space. payload/scope are untouched, so exiting the grill
  // restores the prior canvas structurally (B8 snapshot/restore).
  if (grillScreenActive(skillResult)) {
    return (
      <div className="h-full relative" data-testid="hermes-diagram">
        <GrillScreen topic={skillResult?.visualPayload?.topic as string | undefined} />
      </div>
    );
  }

  // deep_dive REPLACES the diagram with the pocket slide presentation
  // (B14 "pocket dimension" — same sandbox/early-return shape as grill;
  // exiting restores the prior canvas). The pocket is its OWN state, NOT
  // a skill annotation, so it carries its composed slides directly on
  // breadcrumbPocket — no skillResult, hence none of the annotation /
  // drawer / card pipeline fires. An active pocket WITHOUT slides (just
  // the position trail) stays on the diagram path below.
  if (breadcrumbPocket?.slides && breadcrumbPocket.slides.length > 0) {
    return (
      <div className="h-full relative" data-testid="hermes-diagram">
        <DeepDivePocket
          focus={breadcrumbPocket.focus}
          slide={breadcrumbPocket.slide}
          total={breadcrumbPocket.total}
          slides={breadcrumbPocket.slides as PocketSlide[]}
        />
      </div>
    );
  }

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
          // Top padding clears the absolute top-0 chrome bar
          // (Gaps/History/Shelf/Settings, ~40px) so the breadcrumb +
          // KnowledgeStats legend don't underlap/collide with it.
          style={{ padding: '52px 32px 12px' }}
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
          </div>
          {/* "You are here" position trail (B16) — spine ▸ pocket ▸
           *  n/N. The persistent subway-model orientation surface;
           *  the pocket segment appears only inside a deep_dive. */}
          <PositionTrail
            spine={scope === 'project' ? [payload.title] : ['Project', payload.title]}
            pocket={breadcrumbPocket ?? undefined}
          />
          {pipeline && (
            <div
              className="font-mono"
              style={{
                display: 'flex', alignItems: 'center', gap: 12, marginTop: 8,
                fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
                color: 'var(--cream-500)',
              }}
              data-testid="pipeline-strip"
            >
              <span style={{ color: 'var(--amber-400)' }}>Pipeline</span>
              <span>
                stage <span style={{ color: 'var(--cream-100)' }}>{pipeline.step}</span> / {pipeline.total}
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                {Array.from({ length: pipeline.total }).map((_, i) => (
                  <span
                    key={i}
                    style={{
                      width: i < pipeline.step ? 20 : 8, height: 4, borderRadius: 2,
                      background: i < pipeline.step ? 'var(--amber-400)' : 'oklch(1 0 0 / 0.12)',
                      transition: 'all 0.3s ease',
                    }}
                  />
                ))}
              </span>
              <span style={{ display: 'flex', gap: 4 }}>
                {(['source', 'transform', 'guard', 'sink'] as const).map((role, idx) => {
                  const active = pipeline.currentRole === role;
                  return (
                    <span key={role}>
                      {idx > 0 && <span style={{ opacity: 0.35, marginRight: 4 }}>→</span>}
                      <span
                        style={{
                          opacity: active ? 1 : 0.55,
                          color: active ? 'var(--amber-400)' : undefined,
                          fontWeight: active ? 600 : undefined,
                        }}
                      >
                        {role}
                      </span>
                    </span>
                  );
                })}
              </span>
            </div>
          )}
          {blast && (
            <div
              className="font-mono"
              style={{
                display: 'flex', alignItems: 'center', gap: 12, marginTop: 8,
                fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
                color: 'var(--cream-500)',
              }}
              data-testid="blast-strip"
            >
              <span style={{ color: 'oklch(0.72 0.16 55)' }}>Blast radius</span>
              <span style={{ color: 'var(--cream-100)' }}>
                {payload.nodes.find(n => n.id === blast.changedId)?.label ?? blast.changedId}
              </span>
              <span>{blast.rings} {blast.rings === 1 ? 'ring' : 'rings'} of impact</span>
              <span style={{ opacity: 0.65 }}>changed → who breaks if it moves</span>
            </div>
          )}
          {guidedTour && guidedTour.items.length > 0 && (
            <div
              className="font-mono"
              style={{
                display: 'flex', alignItems: 'center', gap: 12, marginTop: 8,
                fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase',
                color: 'var(--cream-500)',
              }}
              data-testid="guided-strip"
            >
              <span style={{ color: 'var(--amber-400)' }}>Guided tour</span>
              <span>
                step <span style={{ color: 'var(--cream-100)' }}>{guidedTour.currentIndex + 1}</span> / {guidedTour.items.length}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {guidedTour.items.map((it, i) => {
                  const cur = i === guidedTour.currentIndex;
                  return (
                    <span
                      key={i}
                      title={it.name}
                      style={{
                        width: cur ? 22 : 8,
                        height: cur ? 6 : 4,
                        borderRadius: 3,
                        background: cur
                          ? 'var(--amber-400)'
                          : i < guidedTour.currentIndex || it.covered
                          ? 'oklch(0.62 0.09 60)'
                          : 'oklch(1 0 0 / 0.12)',
                        transition: 'all 0.3s ease',
                      }}
                    />
                  );
                })}
              </span>
              <span style={{ color: 'var(--cream-200)', textTransform: 'none', letterSpacing: 0 }}>
                {guidedTour.items[guidedTour.currentIndex]?.name ?? ''}
              </span>
            </div>
          )}
          <KnowledgeStrip payload={payload} scope={scope} scores={scores} />
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
      <div
        className="flex-1 relative flex items-start justify-center"
        style={{
          minHeight: 0, padding: '8px 24px 24px',
          // Revalidating: previous diagram stays visible, dimmed. A failed
          // or stalled refetch un-dims (the old canvas is what you HAVE).
          opacity: loading && !error && !stalled ? 0.55 : 1,
          transition: 'opacity 0.2s ease',
        }}
      >
        {/* Refetch failed / hung with a stale canvas up: say so — a
            silent failure here leaves the breadcrumb claiming module/X
            while the canvas still shows the project. */}
        {(error || stalled) ? (
          <div
            className="absolute top-2 right-6 z-10 font-mono flex items-center gap-3"
            style={{
              fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: 'var(--sig-concern)', padding: '4px 10px', borderRadius: 999,
              background: 'color-mix(in oklch, var(--ink-100) 90%, transparent)',
              border: '1px solid color-mix(in oklch, var(--sig-concern) 40%, transparent)',
            }}
            data-testid="diagram-update-failed"
          >
            <span>{error ? `couldn't update: ${error}` : "update stalled"}</span>
            <button
              type="button"
              onClick={retryDiagram}
              className="font-mono"
              style={{ color: 'var(--amber-400)', letterSpacing: 'inherit', textTransform: 'inherit', cursor: 'pointer', background: 'none', border: 'none', padding: 0, font: 'inherit' }}
            >
              retry
            </button>
          </div>
        ) : loading && (
          <div
            className="absolute top-2 right-6 z-10 font-mono"
            style={{
              fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--amber-400)', padding: '4px 10px', borderRadius: 999,
              background: 'color-mix(in oklch, var(--ink-100) 85%, transparent)',
              border: '1px solid color-mix(in oklch, var(--amber-500) 30%, transparent)',
            }}
            data-testid="diagram-updating"
          >
            updating…
          </div>
        )}
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
              const isBack = layeredLayout?.backEdges.has(edgeKey(edge.from, edge.to)) ?? false;
              const path = layeredLayout ? layeredPath(a, b, isBack) : curvedPath(a, b);
              const stroke = edgeStroke(edge.kind);
              // Inferred edges (no import-graph support) read as a guess:
              // faint + dashed, dimmed arrowhead. Honesty over confidence.
              const inferred = edge.inferred === true;
              const dash = inferred ? '3 5' : stroke.dash;
              const color = inferred ? 'oklch(0.5 0.03 65)' : stroke.color;
              const width = inferred ? 1 : stroke.width;
              // Containment spokes are structural — the radial layout
              // already conveys "project contains module", so an
              // arrowhead would impose a misleading dependency reading.
              // Reserve markers for semantic edges (imports / guards /
              // produces / consumes / configures).
              const showMarker = edge.kind !== 'contains';
              const marker = inferred || stroke.markerOpacity <= 0.5 ? 'hd-arrow-dim' : 'hd-arrow';
              return (
                <path
                  key={`e-${i}`}
                  d={path}
                  fill="none"
                  stroke={color}
                  strokeWidth={width}
                  strokeDasharray={dash}
                  strokeOpacity={inferred ? 0.55 : 1}
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
          <motion.g
            // Keyed by the PAYLOAD's scope, not the navigation state: under
            // stale-while-revalidate the scope flips at click time while the
            // old diagram is still on screen — keying on `scope` played the
            // enter motion on the OLD nodes and snapped the new ones in.
            // The payload scope changes exactly when the new content lands.
            key={payload.scope ?? scope}
            initial={scopeMotion.initial}
            animate={scopeMotion.animate}
            transition={{ duration: scopeMotion.duration, ease: 'easeOut' }}
            style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
          >
            {positioned.filter(n => !n.isCenter).map(n => (
              <DiagramNodeView
                key={n.id}
                node={n}
                compact={compact}
                active={n.briefingId !== null && n.briefingId === currentBriefingId}
                anchorPulse={isAnchorMatch(n, anchorSet)}
                dispatchRing={isDispatchPulse(n, dispatchPulseIds) ? (dispatchSettled ? 'settled' : 'pulse') : null}
                breathKey={
                  !dispatchSettled &&
                  visualDispatch?.targetNodeId &&
                  isDispatchPulse(n, new Set([visualDispatch.targetNodeId]))
                    ? visualDispatch.ts
                    : null
                }
                touched={isTouched(n, touchedNodes)}
                heatmapOverlay={heatmapOverlayActive(skillResult, scope)}
                changeHeat={heatByNode ? (heatByNode.get(n.id) ?? 0) : null}
                concern={concernIds.has(n.id)}
                guidedFocus={n.id === guidedFocusId}
                pinned={pinnedIds.has(n.id)}
                dimmed={pipeline ? !pipeline.revealed.has(n.id) : false}
                blastHop={blast ? (blast.hopOf.get(n.id) ?? null) : null}
                roll={scores?.get(n.id) ?? null}
                childrenInfo={childrenInfo.get(n.id) ?? null}
                onNodeClick={onNodeClick}
              />
            ))}
          </motion.g>
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
 *  both work. Takes a pre-lowercased Set (built once per chunk) so the
 *  per-node cost is three lookups, not an array scan. */
function isAnchorMatch(node: PositionedNode, anchors: Set<string>): boolean {
  if (anchors.size === 0) return false;
  const idWithoutPrefix = node.id.replace(/^(module|file|concept)\//, '').toLowerCase();
  const label = node.label.toLowerCase();
  // Full ids too — visual-dispatch refs and newer chunk tags carry
  // `module/core`-style node ids, not just bare labels.
  return anchors.has(node.id.toLowerCase())
    || anchors.has(idWithoutPrefix)
    || anchors.has(label);
}

/** Acknowledgment pulse from a visual:dispatch — refs are full node ids. */
function isDispatchPulse(node: PositionedNode, ids: Set<string>): boolean {
  if (ids.size === 0) return false;
  if (ids.has(node.id)) return true;
  const leaf = node.id.split('/').pop() ?? '';
  for (const id of ids) {
    if (id === leaf || id.split('/').pop() === leaf) return true;
  }
  return false;
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
  /** Phone-width rendering: subtitles + S/Q meta bars are dropped
   *  (illegible at that raster size); the title gets the pixels. */
  compact?: boolean;
  active: boolean;
  anchorPulse?: boolean;
  /** visual:dispatch acknowledgment: 'pulse' = first 3s strong attack,
   *  'settled' = static persistent ring until the next dispatch. */
  dispatchRing?: 'pulse' | 'settled' | null;
  /** Re-keys a one-shot scale breath on the dispatch TARGET node. */
  breathKey?: number | null;
  touched?: boolean;
  heatmapOverlay?: boolean;
  /** whats_changed per-node heat 0..1 (recent change magnitude). null
   *  when the heatmap overlay is inactive. */
  changeHeat?: number | null;
  concern?: boolean;
  /** Current guided-tour step's node — a "you are here" amber halo
   *  that ties the header spine to the canvas. */
  guidedFocus?: boolean;
  pinned?: boolean;
  dimmed?: boolean;
  blastHop?: number | null;
  /** v3 subtree roll-up: components show seenPct + testedSummary
   *  (always summaries); state colour buckets the node. */
  roll?: KnowledgeRoll | null;
  childrenInfo: ChildrenInfo | null;
  /** Stable callback (useCallback in the parent) — combined with memo()
   *  it stops every node re-rendering on every TTS stream chunk. */
  onNodeClick: (n: PositionedNode) => void;
}

const DiagramNodeView = memo(function DiagramNodeView({ node, compact, active, anchorPulse, dispatchRing, breathKey, touched, heatmapOverlay, changeHeat, concern, guidedFocus, pinned, dimmed, blastHop, roll, childrenInfo, onNodeClick }: NodeViewProps) {
  const [hover, setHover] = useState(false);
  // v3: two summary axes (subtree roll-up). Colour encodes only the
  // 4-state category; the precise numbers are the two bars below.
  const seenPct = roll?.seenPct ?? 0;
  const testedPct = roll?.testedSummary ?? 0;
  const hasAnyTest = (roll?.testedSummary ?? 0) > 0 || roll?.ownBest != null;
  const kState: 'mastered' | 'tested' | 'shown' | 'none' =
    roll?.grilled === true ? 'mastered'
      : hasAnyTest ? 'tested'
        : seenPct > 0 ? 'shown'
          : 'none';
  const stateColor =
    kState === 'mastered' ? 'var(--sig-okay)'
      : kState === 'tested' ? 'var(--amber-400)'
        : kState === 'shown' ? 'var(--cream-500)'
          : 'var(--ink-300)';
  const bodyFill =
    kState === 'none'
      ? 'var(--ink-050)'
      : `color-mix(in oklch, ${stateColor} 14%, var(--ink-050))`;
  const titleFill = 'var(--cream-100, #f4ebe1)';
  const subFill = 'var(--cream-500, #b8a99a)';
  // Title size tracks node size — center has the biggest type. The
  // satellite size was bumped from 14→17 because file-scope drill views
  // (n=5+ filename satellites) were unreadable at the default zoom.
  // Compact bumps it further: with subtitles dropped, the title is the
  // node's only text and gets the room.
  const titleSize = node.isCenter ? 24 : compact ? 21 : 17;
  const subSize = node.isCenter ? 13 : 12;
  const lineHeight = subSize * 1.4;

  // Mastery ★ (v3) — grilled (the active-recall QA proof) AND the
  // whole subtree seen (seenPct 100). The glance-readable "done":
  // you've been through all of it and proven it. Replaces the dead
  // level≥confirmed trigger (confirmed is unreachable post-v2).
  const mastered = roll?.grilled === true && (roll?.seenPct ?? 0) >= 100;
  const showCrown = mastered;

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
  const lines = node.description && !compact
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
      onClick={() => onNodeClick(node)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Pipeline walkthrough dims stages not yet revealed (B3). Center
      // is never dimmed. opacity defaults to 1 → identical render when
      // no walkthrough is active (existing baselines unaffected).
      opacity={dimmed && !node.isCenter ? 0.16 : 1}
      style={{ cursor: node.isCenter ? 'default' : 'pointer', transition: 'opacity 0.45s ease' }}
      data-testid={`hd-node-${node.id}`}
      data-active={active ? 'true' : 'false'}
    >
    {/* Inner wrapper carries the one-shot scale "breath" on the dispatch
     *  TARGET (re-keyed per dispatch ts). It must be a separate element:
     *  framer animates via style.transform, which would override the
     *  outer g's positioning transform attribute. No breath → no framer
     *  transform → renders identically to before. */}
    <motion.g
      key={breathKey ?? 'static'}
      animate={breathKey ? { scale: [1, 1.06, 1] } : undefined}
      transition={breathKey ? { duration: 0.6, ease: 'easeOut' } : undefined}
      style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
    >
      {/* whats_changed heatmap (B1) — additive cold→warm wash by DRIFT
       *  (changeHeat 0..1): how much changed here that you haven't
       *  caught up on (red>yellow>green×magnitude, see change-heat.ts).
       *  Not raw churn — the "stay tethered" signal. Recap is spoken;
       *  the diagram is the visual. Additive; never replaces layout. */}
      {heatmapOverlay && changeHeat != null && changeHeat > 0 && (
        <circle
          r={node.radius + 8}
          fill={`color-mix(in oklch, var(--heat-5) ${Math.round(35 + changeHeat * 65)}%, var(--ink-200))`}
          opacity={0.18 + changeHeat * 0.46}
        />
      )}
      {/* Critique concern tint (B5) — additive worry wash on nodes
       *  the critique narration names. Never replaces the body fill
       *  or the layout (IN_PLACE). */}
      {concern && (
        <circle
          r={node.radius + 10}
          fill="none"
          stroke="var(--sig-concern)"
          strokeWidth={3.5}
          opacity={0.95}
          style={{ filter: 'drop-shadow(0 0 5px var(--sig-concern))' }}
        >
          <animate attributeName="opacity" values="0.95;0.5;0.95" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Guided tour "you are here" (B15) — amber halo on the current
       *  step's node so the header spine and the canvas agree. Calm,
       *  additive; distinct from the concern tint's worry pulse. */}
      {guidedFocus && (
        <circle
          r={node.radius + 9}
          fill="none"
          stroke="var(--amber-400)"
          strokeWidth={2.5}
          opacity={0.9}
          style={{ filter: 'drop-shadow(0 0 6px var(--amber-400))' }}
        >
          <animate attributeName="opacity" values="0.9;0.55;0.9" dur="2.4s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Blast-radius ripple (B4) — concentric impact rings keyed to
       *  BFS hop distance from the changed node. hop 0 = the changed
       *  node (strongest, solid warm core), hop 1+ fade outward. Pure
       *  additive halo; null when no blast query active so the normal
       *  render is byte-identical. */}
      {blastHop != null && (
        <circle
          r={node.radius + 9 + blastHop * 3}
          fill={blastHop === 0 ? 'oklch(0.62 0.17 45)' : 'none'}
          fillOpacity={blastHop === 0 ? 0.18 : undefined}
          stroke={blastHop === 0 ? 'oklch(0.72 0.16 55)' : 'oklch(0.66 0.13 50)'}
          strokeWidth={Math.max(1, 3 - blastHop)}
          opacity={Math.max(0.18, 0.85 - blastHop * 0.22)}
        >
          <animate
            attributeName="opacity"
            values={`${Math.max(0.2, 0.9 - blastHop * 0.22)};${Math.max(0.08, 0.35 - blastHop * 0.1)};${Math.max(0.2, 0.9 - blastHop * 0.22)}`}
            dur={`${1.6 + blastHop * 0.4}s`}
            repeatCount="indefinite"
          />
        </circle>
      )}
      {/* Persistent pin (B10) — explicit, user-asserted Notebook
       *  flag. Distinct from the auto touched-halo: a small amber
       *  marker at the node's upper edge. Additive, never clears. */}
      {pinned && (
        <g transform={`translate(${node.radius * 0.92}, ${-node.radius * 0.92})`} aria-label="Flagged in Notebook">
          <circle r={7} fill="oklch(0.74 0.13 70)" stroke="oklch(0.16 0.01 60)" strokeWidth={1.5} />
          <text x={0} y={0.5} textAnchor="middle" dominantBaseline="central" fontSize={8} fill="oklch(0.16 0.01 60)">★</text>
        </g>
      )}
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
      {/* Dispatch acknowledgment — every answered turn visibly moves the
       *  screen. Stage 1 ('pulse', first 3s): a strong expanding ring no
       *  one can miss. Stage 2 ('settled'): a STATIC rounded-rect ring
       *  matching the card shape — "we are talking about THIS" — that
       *  persists until the next answer replaces it. (The old 6s subtle
       *  pulse registered as nothing: a whole live session read as "the
       *  screen never changed".) */}
      {dispatchRing === 'pulse' && !active && (
        <circle
          r={node.radius + 10}
          fill="none"
          stroke="oklch(0.86 0.18 95)"
          strokeWidth={3.5}
          opacity={0.9}
        >
          <animate attributeName="r" values={`${node.radius + 6};${node.radius + 24};${node.radius + 6}`} dur="0.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" repeatCount="indefinite" />
        </circle>
      )}
      {dispatchRing === 'settled' && !active && (
        <rect
          x={-rectWidth / 2 - 7}
          y={-rectHeight / 2 - 7}
          width={rectWidth + 14}
          height={rectHeight + 14}
          rx={18}
          ry={18}
          fill="none"
          stroke="oklch(0.78 0.14 85)"
          strokeWidth={2}
          opacity={0.7}
          data-testid="dispatch-settled-ring"
        />
      )}
      {/* Frontier pulse — very subtle slow glow on nodes the user
       *  has heard about but not yet engaged with. The "one ask away
       *  from explained" affordance: signals where the natural next
       *  question lies. Off when the node is also active, anchor-
       *  pulsing, or dispatch-ringed (stronger signals win). */}
      {!active && !anchorPulse && !dispatchRing && node.level === 'heard' && (
        // Matches the node CARD shape (rounded-rect), not a circle —
        // a circle behind the rounded-rect read as a stray misaligned
        // halo (design-review). Same rx as the body for a clean glow.
        <rect
          x={-rectWidth / 2 - 5}
          y={-rectHeight / 2 - 5}
          width={rectWidth + 10}
          height={rectHeight + 10}
          rx={16}
          ry={16}
          fill="none"
          stroke="oklch(0.55 0.07 60)"
          strokeWidth={1}
          opacity={0.35}
        >
          <animate attributeName="opacity" values="0.15;0.45;0.15" dur="3.6s" repeatCount="indefinite" />
        </rect>
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
        style={{ fill: bodyFill }}
        stroke={
          hover
            ? 'oklch(0.55 0.10 70)'
            : mastered
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
          fill: titleFill,
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
            fill: subFill,
            opacity: 0.9,
          }}
        >
          {lines.map((line, i) => (
            <tspan key={i} x={0} y={subtitleStartY + i * lineHeight}>{line}</tspan>
          ))}
        </text>
      )}
      {/* v3 component glance: TWO summary bars side by side —
       *  S(een) = subtree briefing-coverage % · Q(uiz/Grill) = subtree
       *  avg-of-best %. Both are length-encoded with an explicit
       *  number; "—" = no data. Components ALWAYS show summaries; the
       *  focused node's per-view detail is in the title block. */}
      {!compact && (() => {
        const y = rectHeight / 2 + 16;
        const barW = 38, barH = 5, lblGap = 5, numGap = 5, pairGap = 16;
        const seenTxt = `${seenPct}`;
        const qHasData = testedPct > 0 || roll?.grilled === true;
        const qTxt = qHasData ? `${testedPct}` : '—';
        const numW = 24;
        const grp = 8 + lblGap + barW + numGap + numW; // label+bar+num
        const totalW = grp * 2 + pairGap;
        const x0 = -totalW / 2;
        // 11px floor + cream-600 labels: the old 9px cream-500 row was
        // unreadable without zooming (design-review P0). A 3px minimum
        // fill keeps a 0% bar reading as an empty gauge, not a broken one.
        const Bar = (gx: number, letter: string, frac: number, fill: string, num: string, dim: boolean) => (
          <g>
            <text x={gx} y={y} dominantBaseline="central"
              style={{ fontFamily: 'var(--mono, "Geist Mono", ui-monospace, monospace)', fontSize: 11, fill: 'var(--cream-600)' }}>
              {letter}
            </text>
            <rect x={gx + 8 + lblGap} y={y - barH / 2} width={barW} height={barH} rx={2} fill="var(--ink-100)" />
            <rect x={gx + 8 + lblGap} y={y - barH / 2} width={Math.max(3, barW * Math.max(0, Math.min(1, frac)))} height={barH} rx={2} fill={fill} opacity={dim ? 0.4 : 1} />
            <text x={gx + 8 + lblGap + barW + numGap} y={y} dominantBaseline="central"
              style={{ fontFamily: 'var(--mono, "Geist Mono", ui-monospace, monospace)', fontSize: 11, fill: dim ? 'var(--cream-500)' : fill, opacity: dim ? 0.75 : 1 }}>
              {num}
            </text>
          </g>
        );
        return (
          <g data-testid={`hd-knowledge-${node.id}`} aria-label={`seen ${seenTxt} · quiz/grill ${qTxt}`}>
            {Bar(x0, 'S', seenPct / 100, 'var(--cream-400, var(--cream-500))', seenTxt, seenPct === 0)}
            {Bar(
              x0 + grp + pairGap, 'Q', testedPct / 100,
              roll?.grilled === true ? 'var(--sig-okay)' : 'var(--amber-400)',
              qHasData ? `${qTxt}${roll?.grilled === true ? ' ✓' : ''}` : '—',
              !qHasData,
            )}
          </g>
        );
      })()}
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
        // Below the S/Q row — which compact mode drops, so the pips
        // tuck in close instead of floating over a 16px dead band.
        const rowY = rectHeight / 2 + (compact ? 14 : 30);
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
      {/* (Grill proof now lives in the status chip: green state +
       *  trailing ✓ — no separate shield, one signal not two.) */}
    </motion.g>
    </g>
  );
});


// levelOrdinal / levelColor now come from the single shared model
// (@tetherline/shared + ./level-color.js) — see imports.

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

/** Edge path for the layered (left→right) layout. Forward edges are calm
 *  horizontal-tangent cubics between columns — no perpendicular bow, so a
 *  pipeline reads as clean staged flow. Back edges (cycle-closers) and
 *  same-column edges route UNDER the rows so they don't cross node bodies. */
function layeredPath(a: PositionedNode, b: PositionedNode, back: boolean): string {
  const forward = b.x > a.x + 1;
  if (forward && !back) {
    const x1 = a.x + a.radius * 1.4;
    const x2 = b.x - b.radius * 1.4 - 8;
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${a.y} C ${midX} ${a.y} ${midX} ${b.y} ${x2} ${b.y}`;
  }
  // Back / lateral edge: dip below both endpoints and return.
  const ax = a.x;
  const bx = b.x;
  const ay = a.y + a.radius * 0.9;
  const by = b.y + b.radius * 0.9;
  const dip = Math.max(ay, by) + 70;
  return `M ${ax} ${ay} C ${ax} ${dip} ${bx} ${dip} ${bx} ${by}`;
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


function StatBar({ label, pct, fill }: { label: string; pct: number | null; fill: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={label}>
      <span style={{ opacity: 0.8 }}>{label}</span>
      <span style={{ width: 70, height: 6, borderRadius: 3, background: 'var(--ink-100)', position: 'relative', overflow: 'hidden' }}>
        {pct !== null && (
          <span style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: fill }} />
        )}
      </span>
      <span style={{ color: pct === null ? 'var(--cream-500)' : 'var(--cream-100)' }}>
        {pct === null ? '—' : `${pct}%`}
      </span>
    </span>
  );
}

/** v3 current-layer title block: ▶ replay · ↻ quiz · ⚑ grill · Seen
 *  (deep coverage incl. this node) · Quiz/Grill (BEST for THIS view,
 *  not the components' summary) · weak-spots review.
 *  docs/KNOWLEDGE-MODEL-SPEC.md §4a/§4d. */
function KnowledgeStrip({
  payload, scope, scores,
}: {
  payload: DiagramPayload;
  scope: string;
  scores: Map<string, KnowledgeRoll> | null;
}) {
  const weakSpots = useSessionStore(s => s.weakSpots);
  const forceOpen = useSessionStore(s => s.sceneForceWeakSpotsOpen);
  // An authored flow ships its own narration so ▶ replay can re-speak it
  // instantly (no QA round-trip). Read here (before any early return).
  const flowNarration = useSessionStore(s =>
    (s.skillResult?.skillName === 'visualize'
      ? (s.skillResult.visualPayload as { narration?: string } | undefined)?.narration
      : '') ?? '');
  const [open, setOpen] = useState(false);
  const showPanel = open || forceOpen;

  const cur = payload.nodes.find(n => n.id === scope) ?? payload.nodes[0];
  if (!cur) return null;
  const r = scores?.get(cur.id);
  const seen = r?.seenPct ?? 0;            // deep coverage (incl. own briefing)
  const ownBest = r?.ownBest ?? null;       // best for THIS view, not summary
  const grilled = r?.grilled === true;
  const mine = weakSpots.filter(w => w.itemId === cur.id);

  const ask = (text: string) => {
    // Only log the 'you' line for sends that actually went out.
    if (!sendEvent({ type: 'user:utterance', payload: { text, timestamp: Date.now() } })) {
      useAudioStore.getState().addSpeechToast('Not connected — try again in a moment.', 'error');
      return;
    }
    useSessionStore.getState().addConversation('you', text);
  };
  // ▶ replay: re-speak the authored flow's narration INSTANTLY (no QA
  // round-trip) by feeding the greeting lane; fall back to a fresh explain.
  const replay = () => {
    if (flowNarration.trim()) {
      useSessionStore.setState({ greeting: { text: flowNarration.trim(), briefingId: null } });
    } else {
      ask(`explain ${cur.label}`);
    }
  };
  const resolveSpot = (q: string) =>
    useSessionStore.setState(s => ({ weakSpots: s.weakSpots.filter(w => !(w.itemId === cur.id && w.question === q)) }));

  return (
    <div className="font-mono" style={{ marginTop: 8 }} data-testid="knowledge-strip">
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
        <button type="button" onClick={replay} data-testid="ks-replay"
          className="font-mono" style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--amber-400)', padding: 0, font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' }}>
          ▶ replay
        </button>
        <button type="button" onClick={() => ask(`quiz me on ${cur.label}`)} data-testid="ks-quiz"
          className="font-mono" title="Take/retake this view's quiz" style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--ink-200)', color: 'var(--cream-500)', borderRadius: 4, padding: '0 6px', font: 'inherit', letterSpacing: 'inherit' }}>↻ quiz</button>
        <button type="button" onClick={() => ask(`grill me on ${cur.label}`)} data-testid="ks-grill"
          className="font-mono" title="Grill this view" style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--ink-200)', color: 'var(--cream-500)', borderRadius: 4, padding: '0 6px', font: 'inherit', letterSpacing: 'inherit' }}>⚑ grill</button>
        <StatBar label="Seen" pct={seen} fill="var(--cream-400, var(--cream-500))" />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <StatBar label="Quiz/Grill" pct={ownBest} fill={grilled ? 'var(--sig-okay)' : 'var(--amber-400)'} />
          {grilled && <span style={{ color: 'var(--sig-okay)' }} title="Passed (QA proof)">✓</span>}
        </span>
        {mine.length > 0 && (
          <button type="button" onClick={() => setOpen(o => !o)} data-testid="ks-weakspots-toggle"
            className="font-mono" style={{ cursor: 'pointer', background: 'transparent', border: 'none', color: 'var(--sig-concern, var(--amber-400))', padding: 0, font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit' }}>
            ▸ weak spots ({mine.length})
          </button>
        )}
      </div>
      {showPanel && mine.length > 0 && (
        <div data-testid="weak-spots-panel"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, fontSize: 11, letterSpacing: 0, textTransform: 'none', color: 'var(--cream-300, var(--cream-400))' }}>
          {mine.map(w => (
            <div key={w.question} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--ink-100)', borderRadius: 4, padding: '5px 10px' }}>
              <span style={{ flex: 1 }}>{w.question}</span>
              <span style={{ opacity: 0.5, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{w.source}</span>
              <button type="button" onClick={() => ask(`explain ${cur.label}`)} className="font-mono"
                style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--ink-200)', color: 'var(--cream-500)', borderRadius: 4, padding: '1px 7px', font: 'inherit' }}>restudy ▶</button>
              <button type="button" onClick={() => resolveSpot(w.question)} className="font-mono"
                style={{ cursor: 'pointer', background: 'transparent', border: '1px solid var(--ink-200)', color: 'var(--sig-okay)', borderRadius: 4, padding: '1px 7px', font: 'inherit' }}>resolve ✓</button>
            </div>
          ))}
        </div>
      )}
    </div>
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
