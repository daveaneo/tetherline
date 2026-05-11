import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import type { LLMAdapter, LLMRequest, LLMResponse } from './types.js';
import { canonicalizeRequest, hashRequest } from './canonicalize.js';
import { trace } from '../../dev/trace.js';

export type RecordMode = 'off' | 'record' | 'force';

export interface CassetteOptions {
  cassetteDir: string;        // e.g. test/cassettes
  namespace: string;          // per-test name → subdir under cassetteDir
  underlying: LLMAdapter;     // what to hit when recording / on miss
  mode: RecordMode;           // 'off' = replay-only, 'record' = fill misses, 'force' = re-record
  maxTokens?: number;         // hard cap when recording (default 8192)
  pathRewrites?: Record<string, string>;
}

interface CassetteFile {
  key: string;
  request: {
    model: string;
    system: string;
    messages: unknown[];
    tool?: unknown;
    maxTokens: number;
  };
  response: {
    text: string;
    toolInput?: unknown;
    usage?: { inputTokens: number; outputTokens: number };
  };
}

/**
 * Reads from / writes to YAML cassettes on disk. Default mode is replay-only:
 * a miss throws with the full request body so the failure is informative.
 */
export class CassetteLLMAdapter implements LLMAdapter {
  name = 'cassette';
  private hits = new Set<string>();

  constructor(private opts: CassetteOptions) {
    fs.mkdirSync(this.cassetteDirPath(), { recursive: true });
  }

  private cassetteDirPath(): string {
    return path.join(this.opts.cassetteDir, this.opts.namespace);
  }

  private cassettePath(key: string): string {
    return path.join(this.cassetteDirPath(), `${key}.yaml`);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const canonical = canonicalizeRequest(req, this.opts.pathRewrites);
    const key = hashRequest(req, this.opts.pathRewrites);
    const cassettePath = this.cassettePath(key);
    const exists = fs.existsSync(cassettePath);

    // Force-record: ignore existing, always re-record
    if (this.opts.mode === 'force' || (!exists && this.opts.mode === 'record')) {
      return this.record(req, canonical, key);
    }

    if (!exists) {
      throw new CassetteMissError(
        `cassette miss in namespace '${this.opts.namespace}' (key=${key}). ` +
        `Set RECORD=1 to record, or inspect the request:\n` +
        JSON.stringify(canonical, null, 2).slice(0, 2000),
      );
    }

    // Replay
    const raw = fs.readFileSync(cassettePath, 'utf8');
    const cassette = yamlParse(raw) as CassetteFile;
    this.hits.add(key);

    const t0 = Date.now();
    const response: LLMResponse = {
      id: `llm_cass_${key}`,
      text: cassette.response.text,
      toolInput: cassette.response.toolInput,
      usage: cassette.response.usage,
      cacheHit: true,
      elapsedMs: 0,
    };

    trace({
      kind: 'llm.response',
      sessionId: null,
      durationMs: Date.now() - t0,
      payload: {
        id: response.id,
        cacheHit: true,
        cassetteKey: key,
        text: response.text,
        toolInput: response.toolInput,
      },
    });

    return response;
  }

  private async record(req: LLMRequest, canonical: LLMRequest, key: string): Promise<LLMResponse> {
    const maxTokens = this.opts.maxTokens ?? 8192;
    if (req.maxTokens > maxTokens) {
      throw new Error(`cassette RECORD max tokens exceeded: ${req.maxTokens} > ${maxTokens} (set CASSETTE_MAX_TOKENS to override)`);
    }
    // Hit real adapter
    const actual = await this.opts.underlying.complete(req);

    const cassette: CassetteFile = {
      key,
      request: {
        model: canonical.model,
        system: canonical.system,
        messages: canonical.messages as unknown[],
        tool: canonical.tool,
        maxTokens: canonical.maxTokens,
      },
      response: {
        text: actual.text,
        toolInput: actual.toolInput,
        usage: actual.usage,
      },
    };
    fs.writeFileSync(this.cassettePath(key), yamlStringify(cassette));
    this.hits.add(key);

    console.log(`[cassette] recorded ${this.opts.namespace}/${key}.yaml (${actual.usage?.outputTokens ?? 0} out tokens)`);
    return actual;
  }

  /** Returns cassette keys that were actually replayed during this run. */
  getHits(): string[] {
    return [...this.hits];
  }

  /** Delete cassettes that weren't hit. Call after a full test run. */
  pruneOrphans(): string[] {
    const dir = this.cassetteDirPath();
    if (!fs.existsSync(dir)) return [];
    const all = fs.readdirSync(dir).filter(f => f.endsWith('.yaml'));
    const orphans: string[] = [];
    for (const file of all) {
      const key = file.replace(/\.yaml$/, '');
      if (!this.hits.has(key)) {
        fs.unlinkSync(path.join(dir, file));
        orphans.push(file);
      }
    }
    return orphans;
  }
}

export class CassetteMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteMissError';
  }
}

export function resolveRecordMode(): RecordMode {
  const v = process.env.RECORD;
  if (v === 'force') return 'force';
  if (v === '1' || v === 'true') return 'record';
  return 'off';
}

let bannerShown = false;
export function showRecordBannerIfNeeded(mode: RecordMode) {
  if (mode === 'off' || bannerShown) return;
  bannerShown = true;
  const banner =
    '\n╔══════════════════════════════════════════════════════╗\n' +
    `║  RECORD=${mode.padEnd(6)}  Cassettes WILL be ${mode === 'force' ? 're-recorded' : 'filled on miss'}  ║\n` +
    '║  Real Anthropic API calls will be made & billed.    ║\n' +
    '╚══════════════════════════════════════════════════════╝\n';
  console.warn(banner);
}
