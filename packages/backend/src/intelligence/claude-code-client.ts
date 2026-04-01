/**
 * Claude Code CLI backend — uses the `claude` CLI with the user's subscription.
 * For local development use. Spawns `claude -p` as a subprocess per call.
 *
 * Implements the same interface as ClaudeClient so they're interchangeable.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export class ClaudeCodeClient {
  private model: string;

  constructor(model: string = 'sonnet') {
    this.model = model;
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
    // Combine system + messages into a single prompt for the CLI
    const userMessage = params.messages
      .filter(m => m.role === 'user')
      .map(m => m.content)
      .join('\n\n');

    const fullPrompt = `${params.system}\n\n${userMessage}`;

    const { stdout } = await execFileAsync('claude', [
      '-p', fullPrompt,
      '--model', this.model,
      '--output-format', 'text',
    ], {
      timeout: 120_000, // 2 min max
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env },
    });

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
    // Build a prompt that asks for JSON matching the schema
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

    const { stdout } = await execFileAsync('claude', [
      '-p', fullPrompt,
      '--model', this.model,
      '--output-format', 'text',
    ], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env },
    });

    // Extract JSON from the response (handle potential markdown fences)
    const text = stdout.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to parse JSON from Claude Code response: ${text.slice(0, 200)}`);
    }

    return JSON.parse(jsonMatch[0]) as T;
  }
}
