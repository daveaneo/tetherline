/**
 * ClaudeCodeClient.streamTextLive — NDJSON parsing, degraded mode, and the
 * automatic one-shot fallback when the CLI doesn't support
 * --include-partial-messages (unknown flag → non-zero exit, no output).
 * child_process.spawn is stubbed; no real CLI involved.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const spawnCalls: string[][] = [];
let spawnScripts: Array<(child: FakeChild) => void> = [];

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = { end: () => {} };
  exitCode: number | null = null;
  killed = false;
  kill(_sig?: string) {
    this.killed = true;
    this.exitCode = 143;
    this.stdout.end();
    this.emit('close', 143);
  }
  finish(code: number) {
    this.exitCode = code;
    this.stdout.end();
    this.emit('close', code);
  }
}

vi.mock('child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, ...args]);
    const child = new FakeChild();
    const script = spawnScripts.shift();
    if (script) setTimeout(() => script(child), 5);
    return child;
  },
  execFile: (_cmd: string, _args: string[], _o: unknown, cb?: (e: Error | null, r?: unknown) => void) => {
    cb?.(null, { stdout: '', stderr: '' });
  },
}));

import { ClaudeCodeClient } from '../../packages/backend/src/intelligence/claude-code-client.js';

const PARAMS = {
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'question' }],
};

function streamEventLine(text: string): string {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }) + '\n';
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

beforeEach(() => {
  spawnCalls.length = 0;
  spawnScripts = [];
});

describe('ClaudeCodeClient.streamTextLive', () => {
  it('yields text_delta events from stream-json NDJSON', async () => {
    spawnScripts.push(child => {
      child.stdout.write(streamEventLine('Hello '));
      child.stdout.write(streamEventLine('world.'));
      child.finish(0);
    });
    const client = new ClaudeCodeClient('sonnet');
    const handle = client.streamTextLive(PARAMS);
    expect(await collect(handle.deltas)).toEqual(['Hello ', 'world.']);
    const final = await handle.final;
    expect(final.text).toBe('Hello world.');
    expect(final.aborted).toBeUndefined();
    expect(spawnCalls[0]).toContain('--include-partial-messages');
  });

  it('degraded mode: yields whole assistant messages when no partial events arrive', async () => {
    spawnScripts.push(child => {
      child.stdout.write(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Whole message at once.' }] },
      }) + '\n');
      child.finish(0);
    });
    const client = new ClaudeCodeClient('sonnet');
    const handle = client.streamTextLive(PARAMS);
    expect(await collect(handle.deltas)).toEqual(['Whole message at once.']);
    expect((await handle.final).text).toBe('Whole message at once.');
  });

  it('falls back to one-shot streamText when the flag is unsupported (non-zero exit, no output)', async () => {
    // First spawn: stream-json attempt dies with unknown-flag error.
    spawnScripts.push(child => {
      child.stderr.write('error: unknown option --include-partial-messages\n');
      child.finish(2);
    });
    // Second spawn: the plain-text fallback succeeds.
    spawnScripts.push(child => {
      child.stdout.write('fallback answer\n');
      child.finish(0);
    });
    const client = new ClaudeCodeClient('sonnet');
    const handle = client.streamTextLive(PARAMS);
    expect(await collect(handle.deltas)).toEqual(['fallback answer']);
    expect((await handle.final).text).toBe('fallback answer');
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]).toContain('text');
  });

  it('abort kills the subprocess and final resolves partial with aborted:true', async () => {
    spawnScripts.push(child => {
      child.stdout.write(streamEventLine('partial '));
      // never finishes on its own — abort will kill it
    });
    const client = new ClaudeCodeClient('sonnet');
    const handle = client.streamTextLive(PARAMS);

    const got: string[] = [];
    for await (const d of handle.deltas) {
      got.push(d);
      handle.abort();
    }
    expect(got).toEqual(['partial ']);
    const final = await handle.final;
    expect(final.aborted).toBe(true);
    expect(final.text).toBe('partial');
  });
});
