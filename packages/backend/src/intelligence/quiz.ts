/**
 * Quiz: 3 short-answer questions per layer that move comprehension from
 * passive ("heard") to active ("explained" / "confirmed"). The questions
 * are generated from the current briefing — its title, talking points,
 * and (for project / architecture layers) the children list.
 *
 * If an LLM adapter is available, we ask it for fresh questions tuned
 * to the actual content. Otherwise we fall back to deterministic
 * templates derived from the briefing data so tests stay hermetic.
 *
 * Scoring is intentionally lenient: a fuzzy substring/word-overlap match
 * counts as correct. The point is "do you remember the gist?", not
 * "type the exact phrase."
 */
import type { Briefing } from '@tetherline/shared';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import type { LLMAdapter } from './llm/index.js';

export interface QuizQuestion {
  id: string;
  question: string;
  /** Canonical expected answer the LLM produced. Scored via fuzzy match —
   *  the user doesn't need the exact phrase. */
  expected: string;
}

export interface GenerateQuizParams {
  briefing: Briefing;
  cacheRepo: ContextCacheRepository;
  repoPath: string;
  adapter: LLMAdapter | null;
}

export async function generateQuiz(params: GenerateQuizParams): Promise<QuizQuestion[]> {
  const tpl = templateQuestions(params.briefing);
  if (!params.adapter) return tpl;

  // Try the LLM. If it produces a usable batch, use it; otherwise fall
  // back to the templates (network glitch / cassette miss → still works).
  try {
    const llmQuestions = await llmQuestions_call(params, tpl);
    if (llmQuestions.length >= 3) return llmQuestions.slice(0, 3);
  } catch (err) {
    // swallow — templates are the safety net
  }
  return tpl;
}

async function llmQuestions_call(
  params: GenerateQuizParams,
  fallback: QuizQuestion[],
): Promise<QuizQuestion[]> {
  const { briefing, adapter } = params;
  if (!adapter) return fallback;

  const prompt = [
    `Briefing on "${briefing.title}" (${briefing.layer}):`,
    briefing.opener,
    '',
    briefing.talkingPoints?.length ? `Talking points:\n${briefing.talkingPoints.map(t => `- ${t}`).join('\n')}` : '',
    briefing.children?.length ? `Children: ${briefing.children.join(', ')}` : '',
    '',
    'Generate exactly 3 short quiz questions a developer should be able to answer if they understood this briefing. Each question should have a one-or-two-word canonical answer derived from the briefing content. Reply with JSON only.',
  ].filter(Boolean).join('\n');

  const resp = await adapter.complete({
    model: 'claude-sonnet-4-20250514',
    system: 'You generate short, fair comprehension quizzes from briefings. Output JSON only.',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1024,
    tool: {
      name: 'emit_quiz',
      description: 'Return the 3 quiz questions.',
      inputSchema: {
        type: 'object',
        required: ['questions'],
        properties: {
          questions: {
            type: 'array',
            minItems: 3,
            maxItems: 3,
            items: {
              type: 'object',
              required: ['question', 'expected'],
              properties: {
                question: { type: 'string' },
                expected: { type: 'string' },
              },
            },
          },
        },
      },
    },
  });

  const tool = resp.toolInput as { questions: Array<{ question: string; expected: string }> } | undefined;
  if (!tool?.questions) return fallback;
  return tool.questions.map((q, i) => ({
    id: `${briefing.id}:${i}`,
    question: q.question,
    expected: q.expected,
  }));
}

/** Deterministic question templates — used when no LLM is available
 *  (tests, offline, cassette miss). They riff on briefing data so they're
 *  still meaningfully tied to the layer. */
function templateQuestions(briefing: Briefing): QuizQuestion[] {
  const title = briefing.title;
  const layer = briefing.layer;
  const children = briefing.children ?? [];
  const childLabels = children.map(stripChildId);
  const points = briefing.talkingPoints ?? [];

  const out: QuizQuestion[] = [];

  // Q1 — what is this?
  out.push({
    id: `${briefing.id}:q0`,
    question: `In one sentence, what is ${title} about?`,
    expected: firstSentence(briefing.opener) || title,
  });

  // Q2 — children / parts (when applicable)
  if (childLabels.length >= 1) {
    out.push({
      id: `${briefing.id}:q1`,
      question: layer === 'project' || layer === 'architecture'
        ? `Name one of the main parts of ${title}.`
        : `Name one of the things inside ${title}.`,
      expected: childLabels[0],
    });
  } else if (points[0]) {
    out.push({
      id: `${briefing.id}:q1`,
      question: `What's one thing the briefing said about ${title}?`,
      expected: keyPhrase(points[0]),
    });
  } else {
    out.push({
      id: `${briefing.id}:q1`,
      question: `What layer is ${title} on?`,
      expected: layer,
    });
  }

  // Q3 — second-order detail
  if (childLabels.length >= 2) {
    out.push({
      id: `${briefing.id}:q2`,
      question: `Name another part of ${title}.`,
      expected: childLabels[1],
    });
  } else if (points[1] || points[0]) {
    out.push({
      id: `${briefing.id}:q2`,
      question: `What else stood out about ${title}?`,
      expected: keyPhrase(points[1] ?? points[0]),
    });
  } else {
    out.push({
      id: `${briefing.id}:q2`,
      question: `Briefly, why does ${title} matter?`,
      expected: title,
    });
  }

  return out;
}

/** Substring scoring (either direction), with a minimum-length floor
 *  on the answer so that single-letter / 2-char strings don't game it.
 *  Stricter than the original draft (which had a 50%-word-overlap
 *  fallback that let generic answers pass) but less brittle than
 *  pure-equality (the user's terser "auth" should still match the
 *  canonical "the auth module"). */
export function scoreQuizAnswer(answer: string, expected: string): boolean {
  const a = normalize(answer);
  const e = normalize(expected);
  if (!a || !e) return false;
  // Floor on the answer's length: a 1- or 2-char answer matching
  // anything is gameable. Below 3 normalized chars, hard reject unless
  // it's exact equality.
  if (a.length < 3) return a === e;
  if (a.includes(e)) return true;
  if (e.includes(a)) return true;
  return false;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstSentence(s: string): string {
  const m = (s ?? '').match(/^([^.!?\n]{8,200}[.!?])/);
  return (m ? m[1] : (s ?? '')).trim();
}

function stripChildId(childId: string): string {
  // 'module/auth' → 'auth'; 'arch/root' → 'architecture'
  if (childId === 'arch/root') return 'architecture';
  const slash = childId.indexOf('/');
  return slash === -1 ? childId : childId.slice(slash + 1);
}

function keyPhrase(s: string): string {
  // Pull the first non-trivial noun phrase (very approximate).
  const words = s.split(/\s+/).filter(w => w.length > 3 && !/^(the|that|this|with|from|into|over|just|when|then)$/i.test(w));
  return (words.slice(0, 2).join(' ') || s).slice(0, 40);
}
