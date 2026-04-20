import path from 'path';
import { startHarnessServer, type HarnessServer } from './server.js';
import { DevClient } from './client.js';
import {
  setDefaultLLMAdapter,
  MockLLMAdapter,
  CassetteLLMAdapter,
  AnthropicLLMAdapter,
  resolveRecordMode,
  showRecordBannerIfNeeded,
  type LLMAdapter,
} from '../../packages/backend/src/intelligence/llm/index.js';

export interface TetherlineHarness {
  server: HarnessServer;
  client: DevClient;
  mock: MockLLMAdapter;
  cassette?: CassetteLLMAdapter;
  stop: () => Promise<void>;
}

export interface HarnessOptions {
  /** Use a cassette for LLM calls (replay by default, record on RECORD=1). */
  cassette?: string;
  /** Provide a pre-configured mock instead of cassette. Overrides cassette option. */
  mock?: MockLLMAdapter;
  /** Max wall time a test is allowed before we give up. */
  hardTimeoutMs?: number;
}

/** Repo root — absolute path so cassettes resolve the same everywhere. */
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export const tetherline = {
  async start(opts: HarnessOptions = {}): Promise<TetherlineHarness> {
    // Force cloud mode in tests so all LLM traffic flows through our pluggable
    // adapter (ClaudeCodeClient / local CLI path is unmocked and would hang).
    process.env.INTELLIGENCE_MODE = 'cloud';
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = 'test-sk-placeholder';
    }

    // Install the LLM adapter BEFORE the server starts so all downstream
    // ClaudeClient instances pick it up from getDefaultLLMAdapter().
    const mock = opts.mock ?? new MockLLMAdapter();
    let cassette: CassetteLLMAdapter | undefined;

    if (opts.cassette) {
      const mode = resolveRecordMode();
      showRecordBannerIfNeeded(mode);
      const underlying: LLMAdapter = process.env.ANTHROPIC_API_KEY
        ? new AnthropicLLMAdapter(process.env.ANTHROPIC_API_KEY)
        : mock; // if no key, underlying "record" won't work but replay still does
      cassette = new CassetteLLMAdapter({
        cassetteDir: path.join(REPO_ROOT, 'test/cassettes'),
        namespace: opts.cassette,
        underlying,
        mode,
        maxTokens: Number(process.env.CASSETTE_MAX_TOKENS ?? 8192),
        pathRewrites: { [REPO_ROOT]: 'FIXTURE' },
      });
      setDefaultLLMAdapter(cassette);
    } else {
      setDefaultLLMAdapter(mock);
    }

    const server = await startHarnessServer();
    const client = new DevClient(server.baseUrl);

    return {
      server,
      client,
      mock,
      cassette,
      stop: async () => {
        setDefaultLLMAdapter(null);
        await server.stop();
      },
    };
  },
};
