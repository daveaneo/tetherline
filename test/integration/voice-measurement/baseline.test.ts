/**
 * Baseline voice-interaction measurement. Runs every scenario in scenarios.ts
 * against the current backend, captures trace events, computes metrics, and
 * writes a markdown report to docs/VOICE-BASELINE.md.
 *
 * Re-running after implementing fixes produces a comparable report that lets
 * us see improvements numerically.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { tetherline, type TetherlineHarness } from '../../harness/index.js';
import { MockLLMAdapter } from '../../../packages/backend/src/intelligence/llm/index.js';
import { SCENARIOS, runScenario, type Scenario } from './scenarios.js';

const FIXTURE = '/tmp/tetherline-fixture-small-walkthrough';

function buildMock() {
  const m = new MockLLMAdapter();
  ['group_commits', 'narration_segments', 'architecture_graph', 'flag_concerns', 'rank_impact',
   'quiet_week_suggestion', 'project_overview', 'detect_modules', 'summarize_files'].forEach(t => m.onTool(t, {}));
  m.onTool('classify_intent', { skillName: 'navigate', confidence: 0.9, params: {} });
  m.on(req => !req.tool, { text: 'Generic' });
  return m;
}

function seedBriefing(h: TetherlineHarness) {
  h.server.db.getBriefingRepo().upsert({
    id: 'project', repoPath: FIXTURE, layer: 'project', title: 'fixture',
    opener: 'Fixture project opener.', talkingPoints: [],
    children: [], parent: null, visualCue: { kind: 'none' },
    estimatedSeconds: 8, sourceHash: 'h', cachedAt: new Date().toISOString(),
  });
}

interface MetricsRow {
  scenario: Scenario;
  metrics: Awaited<ReturnType<typeof import('../../harness/client.js').DevClient.prototype.voiceMetrics>>['metrics'];
  scores: Record<string, string>;
}

async function runAllScenarios(h: TetherlineHarness): Promise<MetricsRow[]> {
  const rows: MetricsRow[] = [];

  for (const scenario of SCENARIOS) {
    // Fresh session per scenario so traces don't bleed into each other
    const started = await h.client.startSession({
      repoPath: FIXTURE, entryMode: 'updates', sinceDays: 30,
    });
    await new Promise(r => setTimeout(r, 100));

    await runScenario(h.client, started.devSessionId, scenario);
    const { metrics, scores } = await h.client.voiceMetrics(started.devSessionId);
    rows.push({ scenario, metrics, scores });

    await h.client.resetSession(started.devSessionId);
  }
  return rows;
}

function writeReport(rows: MetricsRow[], outPath: string, label: string) {
  const lines: string[] = [];
  lines.push(`# Voice interaction — ${label} measurement`);
  lines.push('');
  lines.push(`_Generated ${new Date().toISOString()} — ${rows.length} scenarios._`);
  lines.push('');
  lines.push('## Legend');
  lines.push('');
  lines.push('| Metric | Target | Why it matters |');
  lines.push('|---|---|---|');
  lines.push('| `timeToFlushMs` | ≤100ms | User-visible lag between "I started talking" and "AI stopped". |');
  lines.push('| `emitsDuringUserSpeech` | 0 | Server kept generating while user held the floor. |');
  lines.push('| `emitsBeforeFlush` | 0 | Queue leak: narration emitted between user-start and queue-clear. |');
  lines.push('| `timeToRespondMs` | 400-1500ms | Too fast = cut-off. Too slow = laggy. |');
  lines.push('| `selfInterrupts` | 0 | AI started a new segment before the old one ended. |');
  lines.push('| `overlapMs` | ≤100ms | How long AI audio + user audio overlapped. |');
  lines.push('| `flushed` | true | Did the server clear its queue at all on user speech? |');
  lines.push('| `ackDeliveredMs` | ≤2000ms | The spoken ack must SURVIVE the floor gate (held + released, not dropped). |');
  lines.push('');
  lines.push('## Per-scenario results');
  lines.push('');
  lines.push('| # | Scenario | Flush | To-Flush | During | Leaks | To-Respond | Self-int | Overlap | Ack |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const { scenario, metrics, scores } of rows) {
    const mark = (s?: string) => s === 'pass' ? '✅' : s === 'warn' ? '⚠️' : s === 'fail' ? '❌' : '—';
    lines.push(
      `| ${scenario.id} | ${scenario.description.slice(0, 60)} | ` +
      `${mark(scores.flushed)} | ` +
      `${metrics.timeToFlushMs ?? '—'}ms ${mark(scores.timeToFlushMs)} | ` +
      `${metrics.emitsDuringUserSpeech} ${mark(scores.emitsDuringUserSpeech)} | ` +
      `${metrics.emitsBeforeFlush} ${mark(scores.emitsBeforeFlush)} | ` +
      `${metrics.timeToRespondMs ?? '—'}ms ${mark(scores.timeToRespondMs)} | ` +
      `${metrics.selfInterrupts} ${mark(scores.selfInterrupts)} | ` +
      `${metrics.overlapMs}ms ${mark(scores.overlapMs)} | ` +
      `${metrics.ackDeliveredMs ?? '—'}ms ${mark(scores.ackDeliveredMs)} |`,
    );
  }
  lines.push('');

  // Aggregate
  const total = rows.length;
  const pass = (key: string) => rows.filter(r => (r.scores as any)[key] === 'pass').length;
  lines.push('## Aggregate');
  lines.push('');
  lines.push('| Metric | Pass rate |');
  lines.push('|---|---|');
  const keys = ['flushed', 'timeToFlushMs', 'emitsDuringUserSpeech', 'emitsBeforeFlush',
                'timeToRespondMs', 'selfInterrupts', 'overlapMs', 'ackDeliveredMs'];
  for (const k of keys) lines.push(`| ${k} | ${pass(k)}/${total} |`);
  lines.push('');

  lines.push('## Scenarios');
  lines.push('');
  for (const { scenario } of rows) {
    lines.push(`### ${scenario.id}`);
    lines.push(`_${scenario.whatItTests}_`);
    lines.push('');
    lines.push(scenario.description);
    lines.push('');
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
}

describe('Voice interaction — baseline measurement', () => {
  let h: TetherlineHarness;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(FIXTURE, '.git'))) {
      execSync(path.resolve('test/fixtures/create-small-walkthrough.sh') + ' ' + FIXTURE);
    }
    h = await tetherline.start({ mock: buildMock() });
    seedBriefing(h);
  });

  afterAll(async () => { await h?.stop(); });

  it('runs every scenario and writes a report to docs/', async () => {
    const label = process.env.VOICE_REPORT_LABEL ?? 'after-fix';
    const outPath = process.env.VOICE_REPORT_OUT ?? `docs/VOICE-${label.toUpperCase()}.md`;
    const rows = await runAllScenarios(h);
    writeReport(rows, path.resolve(outPath), label);
    expect(rows.length).toBe(SCENARIOS.length);

    // Hard contracts for the floor hold-and-release scenarios. Pre-fix,
    // scenario 13's ack traced tts.drop and never reached the client
    // (ackDeliveredMs === null) — this is the failing-first assertion.
    const ackRow = rows.find(r => r.scenario.id === '13-ack-survives-floor')!;
    expect(ackRow.metrics.ackDeliveredMs, 'the ack must reach the client').not.toBeNull();
    expect(ackRow.metrics.emitsDuringUserSpeech, 'holding must not regress the gate').toBe(0);
    const supersededRow = rows.find(r => r.scenario.id === '14-superseded-turn-stays-silent')!;
    expect(supersededRow.metrics.discardedPending, 'superseded turn must be discarded').toBeGreaterThan(0);
    expect(supersededRow.metrics.emitsDuringUserSpeech).toBe(0);

    const passCount = (key: string) => rows.filter(r => (r.scores as any)[key] === 'pass').length;
    // eslint-disable-next-line no-console
    console.log(`[voice-${label}] flushed pass rate:`, `${passCount('flushed')}/${rows.length}`);
    // eslint-disable-next-line no-console
    console.log(`[voice-${label}] emitsDuring pass rate:`, `${passCount('emitsDuringUserSpeech')}/${rows.length}`);
    // eslint-disable-next-line no-console
    console.log(`[voice-${label}] overlap pass rate:`, `${passCount('overlapMs')}/${rows.length}`);
    // eslint-disable-next-line no-console
    console.log(`[voice-${label}] selfInterrupts pass rate:`, `${passCount('selfInterrupts')}/${rows.length}`);
  }, 60_000);
});
