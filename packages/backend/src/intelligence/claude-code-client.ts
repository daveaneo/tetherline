/**
 * Claude Code CLI backend — uses the `claude` CLI with the user's subscription.
 * For local development use. Spawns `claude -p` as a subprocess per call.
 *
 * Implements the same interface as ClaudeClient so they're interchangeable.
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';

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

  /** Get a text response via `claude -p` */
  async streamText(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    maxTokens?: number;
  }): Promise<string> {
    const userMessage = params.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');
    const fullPrompt = `${params.system}\n\n${userMessage}`;

    const { stdout } = await runClaudeCLI(
      ['-p', fullPrompt, '--model', this.model, '--output-format', 'text'],
      { cwd: this.cwd, timeoutMs: 120_000 },
    );
    return stdout.trim();
  }

  /** Get structured JSON output — asks Claude to respond with JSON, then parses */
  async structuredCall<T>(params: {
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
    maxTokens?: number;
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
      ['-p', fullPrompt, '--model', this.model, '--output-format', 'text'],
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
