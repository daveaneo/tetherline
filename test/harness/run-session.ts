/**
 * Integration test harness for Interactive Reviewer.
 * Starts the server, connects via WebSocket, runs a full session,
 * and reports what works and what doesn't.
 *
 * Usage: npx tsx test/harness/run-session.ts [repo-path] [entry-mode]
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = typeof import.meta.dirname === 'string' ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../.env') });

import WebSocket from 'ws';
import http from 'http';
import { createServer } from '../../packages/backend/src/server.js';
import type { ServerEvent, ClientEvent } from '../../packages/shared/src/types/ws-events.js';
import type { EntryMode } from '../../packages/shared/src/types/modes.js';

// ── Config ──────────────────────────────────────────────
const repoPath = process.argv[2] || '/tmp/test-repo-medium';
const entryMode: EntryMode = (process.argv[3] as EntryMode) || 'full_walkthrough';
const PORT = 3999; // Use a different port to avoid conflicts
const TIMEOUT = 120_000; // 2 minutes max

// ── Test state ──────────────────────────────────────────
interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];
const events: ServerEvent[] = [];
let sessionId = '';

function pass(name: string, detail?: string) {
  results.push({ name, passed: true, detail });
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` (${detail})` : ''}`);
}

function fail(name: string, detail?: string) {
  results.push({ name, passed: false, detail });
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name: string, condition: boolean, detail?: string) {
  if (condition) pass(name, detail);
  else fail(name, detail);
}

// ── Wait for specific event type ────────────────────────
// Global event collector — always running
function startCollecting(ws: WebSocket) {
  ws.on('message', (data: WebSocket.Data) => {
    try {
      const event = JSON.parse(data.toString()) as ServerEvent;
      events.push(event);
    } catch {}
  });
}

let consumedUpTo = 0;

function waitForEvent(
  type: string,
  timeoutMs: number = 30_000,
): Promise<ServerEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
    const interval = setInterval(() => {
      for (let i = consumedUpTo; i < events.length; i++) {
        if (events[i].type === type) {
          consumedUpTo = i + 1;
          clearInterval(interval);
          clearTimeout(timer);
          resolve(events[i]);
          return;
        }
      }
    }, 50);
  });
}


// ── Collect events for a duration ───────────────────────
function collectEvents(ws: WebSocket, durationMs: number): Promise<ServerEvent[]> {
  return new Promise((resolve) => {
    const collected: ServerEvent[] = [];
    function handler(data: WebSocket.Data) {
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        events.push(event);
        collected.push(event);
      } catch {}
    }
    ws.on('message', handler);
    setTimeout(() => {
      ws.off('message', handler);
      resolve(collected);
    }, durationMs);
  });
}

function send(ws: WebSocket, event: ClientEvent) {
  ws.send(JSON.stringify(event));
}

// ── Main ────────────────────────────────────────────────
async function main() {
  console.log(`\n\x1b[1mInteractive Reviewer Integration Test\x1b[0m`);
  console.log(`  Repo: ${repoPath}`);
  console.log(`  Mode: ${entryMode}`);
  console.log(`  Port: ${PORT}\n`);

  // 1. Start server
  console.log('\x1b[1m[1] Server startup\x1b[0m');
  let server: http.Server;
  let cleanup: () => void;
  try {
    const result = await createServer({ port: PORT, repoPath });
    server = result.server;
    cleanup = () => {
      result.wss.close();
      result.db.close();
      server.close();
    };
    await new Promise<void>((resolve, reject) => {
      server.listen(PORT, () => resolve());
      server.on('error', reject);
    });
    pass('Server started');
  } catch (err: any) {
    fail('Server started', err.message);
    process.exit(1);
  }

  // 2. Health check
  try {
    const res = await fetch(`http://localhost:${PORT}/api/health`);
    const data = await res.json() as any;
    check('Health endpoint responds', data.status === 'ok');
    check('Anthropic API key configured', data.hasAnthropicKey === true,
      data.hasAnthropicKey ? 'yes' : 'NO — AI features will not work');
  } catch (err: any) {
    fail('Health endpoint responds', err.message);
  }

  // 3. WebSocket connection
  console.log('\n\x1b[1m[2] WebSocket connection\x1b[0m');
  let ws: WebSocket;
  try {
    ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`ws://localhost:${PORT}/ws`);
      socket.on('open', () => resolve(socket));
      socket.on('error', reject);
    });
    pass('WebSocket connected');
    startCollecting(ws);
  } catch (err: any) {
    fail('WebSocket connected', err.message);
    cleanup!();
    process.exit(1);
  }

  // 4. Start session
  console.log('\n\x1b[1m[3] Session start\x1b[0m');
  try {
    send(ws, { type: 'session:start', payload: { repoPath, sinceDays: 365, entryMode } });

    // Wait for greeting
    const greeting = await waitForEvent('narration:greeting', 10_000);
    check('Greeting received', !!greeting, (greeting.payload as any).text?.slice(0, 60) + '...');

    // Wait for analysis:started
    const started = await waitForEvent('analysis:started', 10_000);
    sessionId = (started.payload as any).sessionId;
    check('Analysis started', !!sessionId, `sessionId: ${sessionId.slice(0, 8)}...`);
  } catch (err: any) {
    fail('Session start events', err.message);
  }

  // 5. Wait for analysis to complete
  console.log('\n\x1b[1m[4] Analysis pipeline\x1b[0m');
  try {
    // Collect events until analysis:complete or timeout
    const analysisComplete = await waitForEvent('analysis:complete', 90_000);
    const payload = analysisComplete.payload as any;
    const areaCount = payload.areas?.length ?? 0;
    check('Analysis completed', !!analysisComplete);
    check('Areas found', areaCount > 0, `${areaCount} areas`);

    if (areaCount > 0) {
      const firstArea = payload.areas[0];
      check('Areas have names', !!firstArea.name, firstArea.name);
      check('Areas have descriptions', !!firstArea.description, firstArea.description?.slice(0, 50) + '...');
      check('Areas have narration segments', (firstArea.narrationSegments?.length ?? 0) > 0,
        `${firstArea.narrationSegments?.length ?? 0} segments`);
    }

    // Check progress events were received
    const progressEvents = events.filter(e => e.type === 'analysis:progress');
    check('Progress events received', progressEvents.length > 0, `${progressEvents.length} events`);

    // Check heatmap
    const heatmapEvents = events.filter(e => e.type === 'session:heatmap');
    check('Heatmap data received', heatmapEvents.length > 0);
  } catch (err: any) {
    fail('Analysis pipeline', err.message);
  }

  // 6. Check proposal (search ALL events, not consumed position)
  console.log('\n\x1b[1m[5] Proposal moment\x1b[0m');
  try {
    // Wait a bit for any trailing events
    await new Promise(r => setTimeout(r, 2000));

    // Wait for proposal (it comes after analysis:complete)
    let proposalEvent = events.find(e => e.type === 'session:proposal');
    if (!proposalEvent) {
      // Wait up to 10s more
      try { proposalEvent = await waitForEvent('session:proposal', 10_000); } catch {}
    }
    check('Proposal event received', !!proposalEvent);
    if (proposalEvent) {
      const pp = proposalEvent.payload as any;
      check('Proposal has message', !!pp.message, pp.message?.slice(0, 60) + '...');
      check('Proposal lists areas', (pp.areas?.length ?? 0) > 0, `${pp.areas?.length ?? 0} areas`);
    }

    const stateEvents = events.filter(e => e.type === 'session:state_changed');
    const proposalState = stateEvents.find(e => (e.payload as any).state.phase === 'PROPOSAL');
    check('State transitioned to PROPOSAL', !!proposalState);
  } catch (err: any) {
    fail('Proposal moment', err.message);
  }

  // 7. Accept proposal and check tour begins
  console.log('\n\x1b[1m[6] Tour flow\x1b[0m');
  try {
    send(ws, { type: 'command:next' });

    // Wait for a state_changed with a phase that's NOT PROPOSAL
    let tourPhase = 'PROPOSAL';
    const deadline = Date.now() + 10_000;
    while (tourPhase === 'PROPOSAL' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const stateEvents = events.filter(e => e.type === 'session:state_changed');
      const lastState = stateEvents[stateEvents.length - 1];
      if (lastState) tourPhase = (lastState.payload as any).state.phase;
    }
    check('Tour started after proposal', tourPhase !== 'PROPOSAL' && tourPhase !== 'IDLE',
      `phase: ${tourPhase}`);

    // Send a few more "next" to walk through
    for (let i = 0; i < 3; i++) {
      send(ws, { type: 'command:next' });
      await new Promise(r => setTimeout(r, 500));
    }

    // Collect what happened
    const allStates = events
      .filter(e => e.type === 'session:state_changed')
      .map(e => (e.payload as any).state.phase);
    const uniquePhases = [...new Set(allStates)];
    check('Multiple phases visited', uniquePhases.length >= 2, uniquePhases.join(' → '));
  } catch (err: any) {
    fail('Tour flow', err.message);
  }

  // 8. Test voice utterance / skill system
  console.log('\n\x1b[1m[7] Skills system\x1b[0m');
  try {
    send(ws, { type: 'user:utterance', payload: { text: 'explain the main module', timestamp: Date.now() } });

    // Wait for either skill:result or skill:clarify or qa:answer_chunk
    const skillResponse = await Promise.race([
      waitForEvent('skill:result', 30_000),
      waitForEvent('skill:clarify', 30_000),
      waitForEvent('qa:answer_chunk', 30_000),
    ]);
    check('Skill/utterance got a response', !!skillResponse, `type: ${skillResponse.type}`);
  } catch (err: any) {
    fail('Skill/utterance response', err.message);
  }

  // Get sessionId from state_changed events as fallback
  if (!sessionId) {
    const stateEvent = events.find(e => e.type === 'session:state_changed');
    if (stateEvent) sessionId = (stateEvent.payload as any).context?.sessionId ?? '';
  }
  if (!sessionId) {
    const startedEvent = events.find(e => e.type === 'analysis:started');
    if (startedEvent) sessionId = (startedEvent.payload as any).sessionId ?? '';
  }

  // 9. Test export
  console.log('\n\x1b[1m[8] Export\x1b[0m');
  try {
    check('Session ID available for export', !!sessionId, sessionId?.slice(0, 8));
    const exportRes = await fetch(`http://localhost:${PORT}/api/export/${sessionId}/markdown`, {
      method: 'POST',
    });
    const exportData = await exportRes.json() as any;
    check('Markdown export succeeds', exportRes.ok && !!exportData.downloadUrl,
      exportData.downloadUrl ?? exportData.error);

    if (exportData.downloadUrl) {
      const dlRes = await fetch(`http://localhost:${PORT}${exportData.downloadUrl}`);
      check('Export file downloadable', dlRes.ok, `${dlRes.status}`);
    }
  } catch (err: any) {
    fail('Export', err.message);
  }

  // 10. Summary
  console.log('\n\x1b[1m[Summary]\x1b[0m');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;
  console.log(`  ${passed} passed, ${failed} failed, ${total} total`);

  if (failed > 0) {
    console.log('\n  \x1b[31mFailed tests:\x1b[0m');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ✗ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }

  console.log(`\n  Events received: ${events.length}`);
  const eventTypes = new Map<string, number>();
  for (const e of events) {
    eventTypes.set(e.type, (eventTypes.get(e.type) ?? 0) + 1);
  }
  for (const [type, count] of [...eventTypes.entries()].sort()) {
    console.log(`    ${type}: ${count}`);
  }

  // Cleanup
  ws.close();
  cleanup!();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
