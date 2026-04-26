import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Briefing, BriefingLayer } from '@tetherline/shared';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import type { IClaudeClient } from '../intelligence/client-interface.js';
import { stripMarkdownForSpeech, validateTTSText } from './tts-safety.js';

/** Best-effort project name detection. Prefers a README first-heading or a
 *  manifest `name` field over the directory basename (which can lag renames
 *  and confuses briefings with stale names). */
function detectProjectName(repoPath: string): string {
  const basename = path.basename(repoPath);
  // Try README.md first — most authoritative for display name.
  for (const filename of ['README.md', 'README.rst', 'README', 'readme.md']) {
    try {
      const content = fs.readFileSync(path.join(repoPath, filename), 'utf8').slice(0, 2000);
      // Look for the first H1 header, stripping HTML <div> wrappers
      const m = content.match(/^#\s+(.+?)(?:\s+v?\d[\d.]*)?\s*$/m);
      if (m) {
        const candidate = m[1].trim();
        if (candidate.length > 0 && candidate.length < 60) return candidate;
      }
    } catch { /* file missing */ }
  }
  // Fall back to package.json name
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) {
      return pkg.name.replace(/^@[^/]+\//, '').replace(/-monorepo$/, '');
    }
  } catch { /* no manifest */ }
  return basename;
}

/**
 * Turns raw context-cache entries (project summary, module summaries, file
 * summaries) into briefings — TTS-safe spoken pitches per depth level.
 *
 * Pipeline per briefing:
 *   1. Pull the raw cache entry.
 *   2. Draft an opener: either deterministic template or LLM-refined.
 *   3. Strip markdown.
 *   4. Validate TTS safety; reject if severe.
 *   5. Wrap with metadata (parent, children, talking points, visual cue).
 */
export class BriefingComposer {
  constructor(
    private cacheRepo: ContextCacheRepository,
    private repoPath: string,
    private aiClient: IClaudeClient | null = null,
  ) {}

  private hash(inputs: string[]): string {
    return createHash('sha256').update(inputs.join('\u0001')).digest('hex').slice(0, 16);
  }

  /** Compose the project-layer briefing. Deterministic if possible (no LLM). */
  composeProject(): Briefing | null {
    const project = this.cacheRepo.getProject(this.repoPath);
    if (!project?.summary) return null;

    // Prefer README/manifest name over directory basename — directories can
    // lag renames (e.g. repo dir is still `interactive-reviewer/` but the
    // project inside is called `Tetherline`).
    const title = detectProjectName(this.repoPath);
    const source = [project.summary, project.purpose ?? ''].join('\n');
    const sourceHash = this.hash([title, source, ...(project.triggerHashes?.head ? [project.triggerHashes.head] : [])]);
    const opener = this.buildProjectOpener(title, project.purpose, project.summary);

    const modules = this.cacheRepo.getModulesForRepo(this.repoPath);
    // Cap at 6 — Miller's-rule cognitive load guard for the radial map.
    // (5 modules + arch/root = 6 satellites.) Order by impactScore so
    // the most-active / most-connected modules surface first; ties fall
    // back to confidence.
    const children = modules
      .filter(m => m.confidence >= 0.3)
      .sort((a, b) => (b.impactScore - a.impactScore) || (b.confidence - a.confidence))
      .slice(0, 5)
      .map(m => `module/${m.modulePath}`);
    children.unshift('arch/root');

    return {
      id: 'project',
      repoPath: this.repoPath,
      layer: 'project',
      title,
      opener,
      talkingPoints: this.pickTalkingPoints(project.summary, 4),
      children,
      parent: null,
      visualCue: { kind: 'none' },
      estimatedSeconds: Math.ceil(opener.split(/\s+/).length / 2.5),
      sourceHash,
      cachedAt: new Date().toISOString(),
    };
  }

  /** Compose the architecture briefing: one voiced tour of the top-level modules. */
  composeArchitecture(): Briefing | null {
    const modules = this.cacheRepo.getModulesForRepo(this.repoPath)
      .filter(m => m.confidence >= 0.3)
      // Gravity-ordered: highest-impact modules first so the architecture
      // tour starts with what's actually moving in the codebase.
      .sort((a, b) => (b.impactScore - a.impactScore) || (b.confidence - a.confidence));
    if (modules.length === 0) return null;

    const opener = this.buildArchitectureOpener(modules);
    const sourceHash = this.hash(modules.map(m => `${m.modulePath}:${m.summary.slice(0, 80)}`));
    // Cap children at 6 to keep the radial map readable. (Miller's law.)
    const children = modules.slice(0, 6).map(m => `module/${m.modulePath}`);

    return {
      id: 'arch/root',
      repoPath: this.repoPath,
      layer: 'architecture',
      title: 'Architecture overview',
      opener,
      talkingPoints: modules.slice(0, 5).map(m => m.modulePath),
      children,
      parent: 'project',
      visualCue: { kind: 'diagram_focus' },
      estimatedSeconds: Math.ceil(opener.split(/\s+/).length / 2.5),
      sourceHash,
      cachedAt: new Date().toISOString(),
    };
  }

  /** Compose a module briefing. */
  composeModule(modulePath: string): Briefing | null {
    const mod = this.cacheRepo.getModule(this.repoPath, modulePath);
    if (!mod?.summary) return null;

    const opener = this.buildModuleOpener(modulePath, mod.summary, mod.keyFiles);
    const sourceHash = this.hash([mod.summary, ...(mod.keyFiles ?? [])]);
    const children = (mod.keyFiles ?? []).slice(0, 6).map(f => `file/${f}`);

    return {
      id: `module/${modulePath}`,
      repoPath: this.repoPath,
      layer: 'module',
      title: modulePath,
      opener,
      // Talking points carry the supplementary insights from the summary
      // (the surprise, the constraint, the "why"). Filenames already appear
      // in the opener — putting them here too sounded like a directory
      // listing when read aloud.
      talkingPoints: this.pickTalkingPoints(mod.summary, 4),
      children,
      parent: 'arch/root',
      visualCue: { kind: 'diagram_focus', ref: modulePath },
      estimatedSeconds: Math.ceil(opener.split(/\s+/).length / 2.5),
      sourceHash,
      cachedAt: new Date().toISOString(),
    };
  }

  /** Compose all briefings we can produce from current cache state. */
  composeAll(): Briefing[] {
    const out: Briefing[] = [];
    const project = this.composeProject();
    if (project) out.push(project);
    const arch = this.composeArchitecture();
    if (arch) out.push(arch);
    const modules = this.cacheRepo.getModulesForRepo(this.repoPath).filter(m => m.confidence >= 0.3);
    for (const m of modules) {
      const briefing = this.composeModule(m.modulePath);
      if (briefing) out.push(briefing);
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────
  // Opener builders — deterministic templates tuned for natural TTS delivery.
  // No bullets, no markdown, natural transitions. Each keeps under 45s spoken.
  // ─────────────────────────────────────────────────────────────

  private buildProjectOpener(name: string, purpose: string | undefined, summary: string): string {
    const cleanedSummary = stripMarkdownForSpeech(summary);
    // Keep up to 4 sentences for the project briefing — this is where the
    // architectural shape + the "watch out for" detail lives, and capping
    // at 2 routinely chopped off the substance line. The 45s spoken-time
    // cap (enforced downstream) is the real ceiling.
    const summarySentences = splitSentences(cleanedSummary).slice(0, 4).join(' ').trim();
    const firstTwoSentences = summarySentences;
    const cleanedPurpose = purpose ? stripMarkdownForSpeech(purpose).trim() : '';

    // Shape the lead sentence around what `purpose` actually looks like.
    // Imperative/tag-line ("Stay tethered to your codebase") reads awkwardly
    // after "X is" — use em-dash. Noun phrases ("a voice-led review tool")
    // read naturally after "X is".
    const IMPERATIVE_VERBS = new Set([
      'stay', 'make', 'build', 'create', 'keep', 'close', 'turn', 'be', 'do', 'find',
      'fix', 'get', 'give', 'go', 'let', 'put', 'run', 'see', 'set', 'take', 'use',
      'help', 'ship', 'open', 'master', 'learn', 'teach', 'save', 'track', 'automate',
      'generate', 'analyze', 'understand', 'explore',
    ]);
    const firstWord = cleanedPurpose.split(/\s+/)[0]?.toLowerCase() ?? '';
    const wordCount = cleanedPurpose.split(/\s+/).length;
    const purposeLooksLikeTagline =
      IMPERATIVE_VERBS.has(firstWord) ||
      (wordCount <= 8 && /^[A-Z][a-z]/.test(cleanedPurpose) && !/\s(is|are|was|were|a|an|the)\s/i.test(cleanedPurpose.split(/\s+/).slice(0, 3).join(' ')));
    const lead = !cleanedPurpose
      ? name
      : purposeLooksLikeTagline
        ? `${name} — ${cleanedPurpose}`
        : `${name} is ${lowerFirst(cleanedPurpose)}`;

    // Avoid immediately repeating the project name if it already appears at
    // the start of the summary.
    const summaryStartsWithName = firstTwoSentences.toLowerCase().startsWith(name.toLowerCase() + ' ');
    let body = summaryStartsWithName
      ? firstTwoSentences.slice(name.length).replace(/^\s+(is|is a|is the)\s+/i, '').trim()
      : firstTwoSentences || 'Let me walk you through it from the top.';
    // Re-capitalize if we trimmed away the sentence opener
    if (body.length > 0 && /^[a-z]/.test(body)) body = body[0].toUpperCase() + body.slice(1);
    // If the body is now redundant with the lead (very short), drop it
    if (body.length < 15) body = '';

    const joiner = /[.!?]$/.test(lead) ? ' ' : '. ';
    const opener = body ? `${lead}${joiner}${body}` : lead;
    return ensureSuffixPrompt(opener, "Say \"walk me through the architecture\" whenever you're ready.");
  }

  private buildArchitectureOpener(modules: Array<{ modulePath: string; summary: string }>): string {
    const top = modules.slice(0, 5).map(m => m.modulePath);
    const names = listJoin(top);
    const count = modules.length;
    const overview = count > 5
      ? `At the top level there are ${count} modules — the ones worth knowing first are ${names}.`
      : `At the top level there are ${count} modules: ${names}.`;
    const lead = modules[0]
      ? `Start at ${modules[0].modulePath}. ${stripMarkdownForSpeech(modules[0].summary).split(/[.\n]/)[0]}.`
      : '';
    return ensureSuffixPrompt(
      `${overview} ${lead}`.trim(),
      'Pick any module and I\'ll go deeper.',
    );
  }

  private buildModuleOpener(modulePath: string, summary: string, keyFiles: string[]): string {
    const cleaned = stripMarkdownForSpeech(summary);
    const body = splitSentences(cleaned).slice(0, 2).join(' ').trim();
    const keyMention = keyFiles.length > 0
      ? `The files doing the heavy lifting are ${listJoin(keyFiles.slice(0, 3))}.`
      : '';
    return ensureSuffixPrompt(
      `${modulePath}. ${body} ${keyMention}`.trim().replace(/\s+/g, ' '),
      'Want to go deeper on a specific file, or step back up?',
    );
  }

  private pickTalkingPoints(summary: string, limit: number): string[] {
    const sentences = splitSentences(stripMarkdownForSpeech(summary));
    return sentences
      // Drop fragments + one-line headings ("Logging.") that read terribly
      // when spoken. Spoken delivery needs at least a subject + verb.
      .filter(s => s.length > 20 && s.length < 200 && s.split(/\s+/).length >= 4)
      .slice(0, limit);
  }
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0].toLowerCase() + s.slice(1) : s;
}

function listJoin(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function ensureSuffixPrompt(opener: string, suffix: string): string {
  const trimmed = opener.replace(/\s+$/, '');
  const joiner = /[.!?]$/.test(trimmed) ? ' ' : '. ';
  const combined = `${trimmed}${joiner}${suffix}`;
  // If validation fails for being too long, keep just the opener without suffix.
  const result = validateTTSText(combined);
  if (!result.ok && result.estimatedSeconds > 30) return trimmed;
  return combined;
}
