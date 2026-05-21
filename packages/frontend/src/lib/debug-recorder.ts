/**
 * Debug recorder (DEV-only).
 *
 * Fires a structured snapshot on every meaningful screen transition —
 * phase, scope, skill, voice state, briefing, shelf — and POSTs it to
 * the backend's `/api/dev/telemetry` JSONL ingest. A second pass
 * captures a downscaled visual via html2canvas, keyed to the same
 * transition id, so the LLM reviewing afterwards can reconstruct the
 * lived experience (state + words + pixels) without the user pasting
 * console output.
 *
 * Pattern follows the global "fire-and-forget diagnostic ingest"
 * guidance: structural beacon sends fast and never drops; the heavy
 * visual is best-effort and won't block the structural record.
 *
 * Production: this module short-circuits on `import.meta.env.DEV` —
 * no listeners attached, no requests made, no html2canvas loaded.
 */
import { useSessionStore } from '../state/session-store.js';
import { useAudioStore } from '../state/audio-store.js';

interface Snapshot {
  id: string;
  reason: string;
  phase: string;
  scope: string | null;
  briefingId: string | null;
  skillName: string | null;
  skillNarrationExcerpt: string | null;
  critiqueActiveIndex: number | null;
  voiceState: string;
  toasts: string[];
  comprehensionCount: number;
  pocketActive: boolean;
  /** Visible chrome text — testids + headings + buttons. */
  domSnapshot: string[];
}

const TELEMETRY_URL = '/api/dev/telemetry';
const SNAPSHOT_DEBOUNCE_MS = 100;
const DOM_SNAPSHOT_MAX_ENTRIES = 40;
const SCREENSHOT_SCALE = 0.4;
const SCREENSHOT_QUALITY = 0.6;
let started = false;

function excerpt(s: string | undefined | null, n = 140): string | null {
  if (!s) return null;
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}

/** Lightweight "what was on screen" — testids, role-y elements,
 *  current narration text. Bounded so payloads stay small. */
function snapshotDom(): string[] {
  if (typeof document === 'undefined') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string | undefined | null) => {
    if (!s) return;
    const t = s.trim().replace(/\s+/g, ' ');
    if (!t || t.length > 160 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
    if (out.length >= DOM_SNAPSHOT_MAX_ENTRIES) throw new Error('STOP_DOM');
  };
  try {
    document.querySelectorAll<HTMLElement>('[data-testid]').forEach(el => {
      push(`[${el.dataset.testid}] ${el.textContent ?? ''}`);
    });
    document.querySelectorAll<HTMLElement>('h1, h2, h3').forEach(el => push(el.textContent));
    document.querySelectorAll<HTMLButtonElement>('button[aria-label]').forEach(el => {
      push(`btn: ${el.getAttribute('aria-label')}`);
    });
  } catch (e) {
    if (!(e instanceof Error && e.message === 'STOP_DOM')) throw e;
  }
  return out;
}

function readSnapshot(reason: string, id: string): Snapshot {
  const s = useSessionStore.getState();
  const a = useAudioStore.getState();
  const skill = s.skillResult ?? null;
  const payload = s.sceneDiagramPayload ?? null;
  return {
    id,
    reason,
    phase: s.state.phase,
    scope: payload?.scope ?? null,
    briefingId: s.currentBriefing?.briefingId ?? null,
    skillName: skill?.skillName ?? null,
    skillNarrationExcerpt: excerpt(skill?.narration),
    critiqueActiveIndex: skill?.skillName === 'critique' ? s.critiqueActiveIndex : null,
    voiceState: a.voiceState,
    toasts: a.speechToasts.map(t => (typeof t === 'string' ? t : (t as { text?: string }).text ?? '')).slice(-5),
    comprehensionCount: s.comprehensionMap.size,
    pocketActive: !!s.breadcrumbPocket?.slides?.length,
    domSnapshot: snapshotDom(),
  };
}

function post(body: Record<string, unknown>): void {
  // keepalive lets the request survive teardown (page nav, hot-
  // reload). sendBeacon caps at 64KB; we need more for visuals.
  fetch(TELEMETRY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => { /* best-effort */ });
}

let visualBusy = false;
async function captureVisual(id: string): Promise<void> {
  if (visualBusy) return; // drop overlapping captures rather than queue
  visualBusy = true;
  try {
    const html2canvas = (await import('html2canvas')).default;
    const canvas = await html2canvas(document.body, {
      scale: SCREENSHOT_SCALE,
      logging: false,
      // Skip foreignObject — perf + sometimes flaky for complex SVG.
      foreignObjectRendering: false,
      backgroundColor: null,
    });
    const dataUrl = canvas.toDataURL('image/jpeg', SCREENSHOT_QUALITY);
    post({ kind: 'visual', id, w: canvas.width, h: canvas.height, dataUrl });
  } catch {
    /* visual is best-effort — the structural record stands on its own */
  } finally {
    visualBusy = false;
  }
}

/** Equality across the fields that count as a "screen transition".
 *  Kept loose: a change in any of these fires one beacon. */
function transitionKey(s: Snapshot): string {
  return [
    s.phase,
    s.scope ?? '-',
    s.skillName ?? '-',
    s.briefingId ?? '-',
    s.voiceState,
    s.pocketActive ? 'P' : '-',
  ].join('|');
}

/** Wire up the recorder. Idempotent; safe to call from React effects. */
export function startDebugRecorder(): void {
  if (started || !import.meta.env.DEV) return;
  started = true;
  let prevKey: string | null = null;
  let counter = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const considerTransition = (reason: string): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const id = `${Date.now().toString(36)}-${(++counter).toString(36)}`;
      const snap = readSnapshot(reason, id);
      const key = transitionKey(snap);
      if (key === prevKey) return; // de-dup re-renders that didn't move the needle
      prevKey = key;
      post({ kind: 'structural', ...snap });
      void captureVisual(id);
    }, SNAPSHOT_DEBOUNCE_MS);
  };

  useSessionStore.subscribe(() => considerTransition('session'));
  useAudioStore.subscribe(() => considerTransition('audio'));
  // Initial snapshot — the "before anything happened" baseline.
  considerTransition('init');

  // eslint-disable-next-line no-console
  console.info('[debug-recorder] active — POSTing to %s. Tail /tmp/tetherline-debug.jsonl.', TELEMETRY_URL);
}
