/**
 * Builds the system prompt for Q&A from the project's cached context.
 *
 * Two failure modes this guards against:
 *   1. The LLM has no idea what project it's reasoning about. Symptom:
 *      user asks "what is this?" right after a briefing, model replies
 *      "what project?". Fixed by including project name + summary always.
 *   2. The LLM treats every question as if it's the first one. Future-proof
 *      for conversation history threading (see `recentTurns`).
 *
 * The scaffold is layered: cheap cached facts first (always relevant), then
 * the current navigation context (where in the session we are), then
 * exploration permissions (for the agentic Claude Code CLI path).
 */
import path from 'path';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import { depthInstruction, type DepthTier } from './depth-modifiers.js';
import { REFS_INSTRUCTION } from './answer-refs.js';

export interface QAContextOptions {
  /** What the user is currently looking at — area name + description, breadcrumb, etc. */
  currentLocation?: string;
  /** Whether the executing client can spawn read-only file tools (Claude Code CLI). */
  agenticTools?: boolean;
  /** Recent assistant/user exchanges to thread for follow-up coherence. Newest last. */
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Cap on module summary lines to keep the prompt compact. */
  maxModules?: number;
  /** Answer-length tier — 'tldr' / 'normal' / 'deep'. Defaults to 'normal'. */
  depthTier?: DepthTier;
}

export function buildQAContext(
  cacheRepo: ContextCacheRepository,
  repoPath: string,
  opts: QAContextOptions = {},
): string {
  const project = cacheRepo.getProject(repoPath);
  const modules = cacheRepo.getModulesForRepo(repoPath)
    .filter(m => m.confidence >= 0.3)
    .slice(0, opts.maxModules ?? 12);

  const projectName = project?.summary
    ? extractProjectName(project.summary, repoPath)
    : path.basename(repoPath);

  const lines: string[] = [];

  const lengthGuidance = depthInstruction(opts.depthTier ?? 'normal');
  lines.push(
    `You are Hermes — the developer's guide through "${projectName}". Hermes in myth led ` +
    `lost souls home and carried messages between worlds; here, you help a developer find ` +
    `their way through a codebase that's getting away from them. Be warm, specific, and ` +
    `economical — no filler, no "I'm here to help" pleasantries, no gushing ("beautifully ` +
    `streamlined", "what's really clever"): praise only with the specific evidence that earns it. ` +
    `When the user says "the project," "this," "the codebase," or "this app" — they mean ` +
    `${projectName} at ${repoPath}. ` +
    `Your reply will be spoken aloud, so use natural prose — no bullet lists, no markdown headers. ` +
    `EXCEPTION: when the user asks for commands, code, or anything they'd copy-paste, put exactly ` +
    'that content in a fenced code block (```bash … ```). Fenced blocks are SHOWN on screen with a ' +
    `copy button and never spoken — do not read code or commands aloud; one short prose sentence ` +
    `around the block is enough. ` +
    `${lengthGuidance} Don't introduce yourself unless asked.`,
  );

  if (project?.summary) {
    lines.push('', '## Project', project.summary.trim());
    if (project.purpose) lines.push(`Purpose: ${project.purpose.trim()}`);
    if (project.techStack && project.techStack.length > 0) {
      lines.push(`Tech: ${project.techStack.slice(0, 8).join(', ')}.`);
    }
  }

  if (modules.length > 0) {
    // Order modules by gravity so the most-active ones show up first.
    // The LLM's working memory is finite — front-loading the modules
    // worth knowing about pays off on questions like "where would I
    // add X?" since the answer is usually in a module the user has
    // recently touched.
    const orderedModules = [...modules].sort(
      (a, b) => ((b as any).impactScore ?? 0) - ((a as any).impactScore ?? 0),
    );
    lines.push('', '## Modules');
    for (const m of orderedModules) {
      const oneLiner = firstSentence(m.summary).slice(0, 200);
      lines.push(`- \`${m.modulePath}\` — ${oneLiner}`);
    }

    // Connection-aware section: dependency edges between modules so
    // questions like "how does auth connect to payments?" or "if I
    // wanted to add rate limiting, which module would I touch?" can be
    // answered structurally, not by guessing. We only emit edges where
    // both endpoints are real modules (skips noise from third-party
    // imports). Bounded to the top 30 edges so the prompt stays tight.
    const edges = collectModuleEdges(modules);
    if (edges.length > 0) {
      lines.push('', '## Module connections (dependency edges)');
      for (const edge of edges.slice(0, 30)) {
        lines.push(`- \`${edge.from}\` imports from \`${edge.to}\``);
      }
    }
  }

  if (opts.currentLocation) {
    lines.push('', '## Where the user is now', opts.currentLocation.trim());
  }

  if (opts.agenticTools) {
    lines.push(
      '',
      '## Exploration',
      `You have read access to the repo at ${repoPath}. When the question is specific ` +
      `(e.g. "how does X work?", "what calls Y?"), feel free to read files, grep, or list ` +
      `directories. Read only what you need — don\'t dump file trees. Always ground your ` +
      `answer in actual code, not assumptions. If you look and still can\'t find it, say ` +
      `you don\'t see it in the repo.`,
    );
  } else {
    lines.push(
      '',
      '## Grounding',
      `Base every factual claim about ${projectName} on the summaries and any repository ` +
      `file contents you are given. If the user asks about something that is not there, ` +
      `say plainly that you don\'t see it in the repo. Never invent file names, commands, ` +
      `dependencies, or setup steps.`,
    );
  }

  if (opts.recentTurns && opts.recentTurns.length > 0) {
    lines.push('', '## Recent exchange (for continuity)');
    for (const turn of opts.recentTurns.slice(-6)) {
      lines.push(`${turn.role === 'user' ? 'User' : 'You'}: ${turn.content.trim()}`);
    }
  }

  lines.push('', '## Visual refs', REFS_INSTRUCTION);

  return lines.join('\n');
}

/** Strip a leading "X is …" pattern to recover the project name. Falls back
 *  to repo basename if the summary doesn't start with the canonical form. */
function extractProjectName(summary: string, repoPath: string): string {
  const m = summary.match(/^([A-Z][\w-]*(?:\s+[A-Z][\w-]*)?)\s+(?:is|—|-)/);
  if (m && m[1].length < 40) return m[1].trim();
  return path.basename(repoPath);
}

/** Extract module-to-module dependency edges from the imports each
 *  module declares. Each module's `imports` field holds module names
 *  (not file paths) — we only emit edges where both ends are known
 *  modules in the cache, filtering out noise from npm packages and
 *  in-module relative imports. */
function collectModuleEdges(modules: Array<{ modulePath: string; imports?: string[] }>): Array<{ from: string; to: string }> {
  const knownModules = new Set(modules.map(m => m.modulePath));
  const edges: Array<{ from: string; to: string }> = [];
  for (const m of modules) {
    for (const imp of m.imports ?? []) {
      if (imp === m.modulePath) continue;
      if (!knownModules.has(imp)) continue;
      edges.push({ from: m.modulePath, to: imp });
    }
  }
  return edges;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^([^.!?\n]+[.!?])/);
  return (m ? m[1] : trimmed).trim();
}
