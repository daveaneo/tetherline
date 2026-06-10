/**
 * Claude Code CLI backend — uses the `claude` CLI with the user's subscription.
 * For local development use. Spawns `claude -p` as a subprocess per call.
 *
 * Implements the same interface as ClaudeClient so they're interchangeable.
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import type { LLMResponse, LLMStreamHandle } from './llm/types.js';

const execFileAsync = promisify(execFile);

interface RunResult { stdout: string; stderr: string; }

/**
 * Run `claude` with stdin closed immediately. The CLI otherwise warns at
 * "no stdin data received in 3s" and may exit non-zero depending on version.
 */
function runClaudeCLI(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin right away so the CLI doesn't wait for input.
    try { child.stdin.end(); } catch { /* already closed */ }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d.toString(); });
    child.stderr?.on('data', d => { stderr += d.toString(); });

    const timer = opts.timeoutMs ? setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude CLI timed out after ${opts.timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`));
    }, opts.timeoutMs).unref() : null;

    child.on('error', err => {
      if (timer) clearTimeout(timer as unknown as NodeJS.Timeout);
      reject(err);
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer as unknown as NodeJS.Timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`claude CLI exited ${code}. stderr: ${stderr.slice(0, 500)}`));
    });
  });
}

export class ClaudeCodeClient {
  private model: string;
  private cwd: string | undefined;

  constructor(model: string = 'sonnet', cwd?: string) {
    this.model = model;
    this.cwd = cwd; // Scope CLI to the target repo directory
  }

  /** Check if the `claude` CLI is available */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('claude', ['--version'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Map a full API model id to the CLI's short alias when recognizable. */
  private cliModel(override?: string): string {
    if (!override) return this.model;
    if (/haiku/i.test(override)) return 'haiku';
    if (/sonnet/i.test(override)) return 'sonnet';
    if (/opus/i.test(override)) return 'opus';
    return override;
  }

  /** Get a text response via `claude -p` */
  async streamText(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    model?: string;
  }): Promise<string> {
    const userMessage = params.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');
    const fullPrompt = `${params.system}\n\n${userMessage}`;

    const { stdout } = await runClaudeCLI(
      ['-p', fullPrompt, '--model', this.cliModel(params.model), '--output-format', 'text'],
      { cwd: this.cwd, timeoutMs: 120_000 },
    );
    return stdout.trim();
  }

  /**
   * True token streaming via `--output-format stream-json` with partial
   * messages. CLI version variance is handled by an automatic one-shot
   * fallback: if the flag is unsupported or NDJSON parsing yields nothing,
   * the whole completion arrives as a single delta via streamText().
   */
  streamTextLive(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
    model?: string;
  }): LLMStreamHandle {
    const userMessage = params.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');
    const fullPrompt = `${params.system}\n\n${userMessage}`;
    const model = params.model ?? this.model;
    const t0 = Date.now();

    const child = spawn('claude', [
      '-p', fullPrompt,
      '--model', model,
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ], {
      cwd: this.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try { child.stdin.end(); } catch { /* already closed */ }

    let aborted = false;
    let received = '';
    let stderr = '';
    child.stderr?.on('data', d => { stderr += d.toString(); });

    const self = this;
    let settle!: () => void;
    const settled = new Promise<void>(r => { settle = r; });

    const deltas = (async function* () {
      let lineBuf = '';
      let sawAnyDelta = false;
      let exitCode: number | null = null;
      const exited = new Promise<void>(res => child.on('close', code => { exitCode = code; res(); }));

      // Async iterate stdout line-by-line as NDJSON.
      try {
       try {
        for await (const data of child.stdout) {
          lineBuf += data.toString();
          let nl: number;
          while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            let obj: any;
            try { obj = JSON.parse(line); } catch { continue; }
            // --include-partial-messages wraps raw API events as stream_event.
            const ev = obj.type === 'stream_event' ? obj.event : obj;
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              sawAnyDelta = true;
              received += ev.delta.text;
              yield ev.delta.text as string;
            } else if (!sawAnyDelta && obj.type === 'assistant' && obj.message?.content) {
              // Degraded mode (no partial messages): whole assistant message
              // objects still stream one per turn — yield each as one delta.
              const text = (obj.message.content as any[])
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('');
              if (text) {
                received += text;
                yield text;
              }
            }
          }
        }
       } catch {
        // stdout iteration error (e.g. SIGTERM on abort) — fall through.
       }
       await exited;
       if (aborted || received) return;
       // Nothing usable arrived (unknown flag, parse failure, non-zero exit):
       // automatic one-shot fallback through the plain text path.
       if (exitCode !== 0 || !received) {
        const text = await self.streamText(params);
        received = text;
        if (text) yield text;
       }
      } finally {
        // Settles `final` whether iteration completed, aborted, errored, or
        // was abandoned via return(). sawAnyDelta intentionally unused after
        // degraded-mode detection.
        void sawAnyDelta;
        settle();
      }
    })();

    const final: Promise<LLMResponse> = settled.then(() => ({
      id: `llm_cli_${t0.toString(36)}`,
      text: received.trim(),
      cacheHit: false,
      elapsedMs: Date.now() - t0,
      ...(aborted ? { aborted: true } : {}),
    }));

    return {
      deltas,
      final,
      abort() {
        if (aborted) return;
        aborted = true;
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
      },
    };
  }

  /** Get structured JSON output — asks Claude to respond with JSON, then parses */
  async structuredCall<T>(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
    model?: string;
  }): Promise<T> {
    const schemaStr = JSON.stringify(params.inputSchema, null, 2);
    const userMessage = params.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');

    const fullPrompt = `${params.system}

${userMessage}

IMPORTANT: Respond ONLY with a valid JSON object matching this schema. No markdown, no explanation, no code fences — just the raw JSON.

Schema:
${schemaStr}`;

    const { stdout } = await runClaudeCLI(
      ['-p', fullPrompt, '--model', this.cliModel(params.model), '--output-format', 'text'],
      { cwd: this.cwd, timeoutMs: 120_000 },
    );

    const text = stdout.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to parse JSON from Claude Code response: ${text.slice(0, 200)}`);
    }
    return JSON.parse(jsonMatch[0]) as T;
  }
}
