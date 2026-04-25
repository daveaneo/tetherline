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

export interface QAContextOptions {
  /** What the user is currently looking at — area name + description, breadcrumb, etc. */
  currentLocation?: string;
  /** Whether the executing client can spawn read-only file tools (Claude Code CLI). */
  agenticTools?: boolean;
  /** Recent assistant/user exchanges to thread for follow-up coherence. Newest last. */
  recentTurns?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Cap on module summary lines to keep the prompt compact. */
  maxModules?: number;
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

  lines.push(
    `You are the in-session voice of "${projectName}", helping a developer learn this codebase. ` +
    `When they say "the project," "this," "the codebase," or "this app" — they mean ${projectName} at ${repoPath}. ` +
    `Answer concisely and conversationally; your reply will be spoken aloud. Aim for 2–4 sentences unless asked to go deep.`,
  );

  if (project?.summary) {
    lines.push('', '## Project', project.summary.trim());
    if (project.purpose) lines.push(`Purpose: ${project.purpose.trim()}`);
    if (project.techStack && project.techStack.length > 0) {
      lines.push(`Tech: ${project.techStack.slice(0, 8).join(', ')}.`);
    }
  }

  if (modules.length > 0) {
    lines.push('', '## Modules');
    for (const m of modules) {
      const oneLiner = firstSentence(m.summary).slice(0, 200);
      lines.push(`- \`${m.modulePath}\` — ${oneLiner}`);
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
      `answer in actual code, not assumptions.`,
    );
  }

  if (opts.recentTurns && opts.recentTurns.length > 0) {
    lines.push('', '## Recent exchange (for continuity)');
    for (const turn of opts.recentTurns.slice(-6)) {
      lines.push(`${turn.role === 'user' ? 'User' : 'You'}: ${turn.content.trim()}`);
    }
  }

  return lines.join('\n');
}

/** Strip a leading "X is …" pattern to recover the project name. Falls back
 *  to repo basename if the summary doesn't start with the canonical form. */
function extractProjectName(summary: string, repoPath: string): string {
  const m = summary.match(/^([A-Z][\w-]*(?:\s+[A-Z][\w-]*)?)\s+(?:is|—|-)/);
  if (m && m[1].length < 40) return m[1].trim();
  return path.basename(repoPath);
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^([^.!?\n]+[.!?])/);
  return (m ? m[1] : trimmed).trim();
}
