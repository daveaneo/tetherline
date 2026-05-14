/**
 * grill_me — adaptive Socratic comprehension test.
 *
 * Two flavors of consumer:
 *   (a) Tech lead grilling devs on a system before letting them touch
 *       it. Wants confidence the dev can defend decisions, not just
 *       parrot the docs. Style: relentless, what-would-happen-if.
 *   (b) Dev growing his own understanding. Wants blind spots surfaced,
 *       hints when stuck, calibrated difficulty. Style: collaborative.
 *
 * Both flavors share one mechanism: pick a topic, ask one focused
 * question, evaluate the answer, then either drill deeper (weak
 * answer) or pivot to an adjacent branch (strong answer). End on user
 * "stop" / "enough" / "I give up" or after the topic tree is walked.
 *
 * Stateless: this module exposes pure-ish functions; the session
 * manager owns the GrillSession state across user turns and threads it
 * through each call.
 */
import type { IClaudeClient } from './client-interface.js';

export type GrillTone = 'coach' | 'strict';

export interface GrillTurn {
  question: string;
  answer?: string;
  evaluation?: 'strong' | 'partial' | 'weak';
  evaluationNote?: string;
}

export interface GrillSession {
  /** What's being grilled — a module name, concept, file, etc. */
  topic: string;
  /** Project context the grill draws from (project summary, module
   *  description, etc.). Cached at start so questions stay focused. */
  context: string;
  /** Style. 'coach' = collaborative+patient. 'strict' = lead-style,
   *  pushes back harder, less hand-holding. */
  tone: GrillTone;
  /** Q/A history in order. */
  turns: GrillTurn[];
  /** True once the AI signals topic exhaustion or user said stop. */
  done: boolean;
  /** Optional summary the AI emits at end-of-grill: "you nailed X,
   *  shaky on Y, didn't reach Z." */
  finalNote?: string;
}

const MAX_QUESTIONS = 6;

/** Phrases that signal the user wants to end the grill OR navigate
 *  away from it. Once a grill is active, handleUtterance routes
 *  everything to the grill loop — so the only way the user can
 *  cleanly exit is by us recognising their intent here. Includes
 *  both explicit stops ("stop", "enough") AND common navigation
 *  intents ("exit", "back to project", "go back") so the user is
 *  never trapped in a grill.
 *  Matches as standalone phrases only (≤4 words, end-anchored) to
 *  avoid swallowing a real answer that happens to contain a stop
 *  word in passing. */
const STOP_PATTERNS = [
  /^stop\.?$/i,
  /^enough\.?$/i,
  /^that'?s enough\.?$/i,
  /^i give up\.?$/i,
  /^no more\.?$/i,
  /^okay (i'?m )?done\.?$/i,
  /^end (the )?grill\.?$/i,
  /^exit\.?$/i,
  /^quit\.?$/i,
  /^back\.?$/i,
  /^go back\.?$/i,
  /^back to project\.?$/i,
  /^cancel\.?$/i,
  /^pause\.?$/i,
];

export function userSaidStop(text: string): boolean {
  const t = text.trim();
  return STOP_PATTERNS.some(p => p.test(t));
}

/** Open the grill: pick a topic, ask the first question. */
export async function startGrill(
  claude: IClaudeClient,
  params: { topic: string; context: string; tone: GrillTone },
): Promise<{ session: GrillSession; firstQuestion: string }> {
  const session: GrillSession = {
    topic: params.topic,
    context: params.context,
    tone: params.tone,
    turns: [],
    done: false,
  };
  const firstQuestion = await askNext(claude, session);
  session.turns.push({ question: firstQuestion });
  return { session, firstQuestion };
}

/** User answered. Evaluate, decide whether to deepen / pivot / end,
 *  return the AI's spoken response (eval + next question OR final note).
 *  Mutates the session in place. */
export async function respondToAnswer(
  claude: IClaudeClient,
  session: GrillSession,
  answer: string,
): Promise<{ spoken: string; evaluation: 'strong' | 'partial' | 'weak'; done: boolean }> {
  if (userSaidStop(answer)) {
    session.done = true;
    const note = await summarizeGrill(claude, session, /*userQuit*/ true);
    session.finalNote = note;
    return { spoken: note, evaluation: 'partial', done: true };
  }

  const lastTurn = session.turns[session.turns.length - 1];
  if (lastTurn) {
    lastTurn.answer = answer;
  }

  // One LLM call: evaluate AND produce the next move.
  const result = await evaluateAndContinue(claude, session, answer);

  if (lastTurn) {
    lastTurn.evaluation = result.evaluation;
    lastTurn.evaluationNote = result.evaluationNote;
  }

  // Termination conditions
  const reached = session.turns.length >= MAX_QUESTIONS;
  if (reached || result.done) {
    session.done = true;
    const note = await summarizeGrill(claude, session, /*userQuit*/ false);
    session.finalNote = note;
    return { spoken: result.feedback + ' ' + note, evaluation: result.evaluation, done: true };
  }

  session.turns.push({ question: result.nextQuestion });
  return {
    spoken: result.feedback + ' ' + result.nextQuestion,
    evaluation: result.evaluation,
    done: false,
  };
}

// ─── Internal LLM helpers ─────────────────────────────────────────────

async function askNext(claude: IClaudeClient, session: GrillSession): Promise<string> {
  const tonePrompt = session.tone === 'strict'
    ? 'You are a tech lead grilling a developer on this system. Be relentless and probing — the dev claims understanding; prove it. Push back on shallow answers. Style: Socratic, what-would-happen-if.'
    : 'You are a coach helping a developer build deep understanding. Patient, curious, calibrated to their level. Use hints when they stumble. Style: collaborative learning partnership.';

  const opener = `${tonePrompt}

Ask ONE focused, open-ended question about ${session.topic} that tests UNDERSTANDING (not memory).
Prefer "what would happen if X" over "what is X". Keep the question short, conversational, spoken aloud.

Context the user has been studying:
${session.context}

This is the first question — open the grill with something approachable but substantive. Output ONLY the question itself, no preamble.`;

  return claude.streamText({
    system: 'You are an interactive grill-the-dev coach. Output ONLY the question or feedback the user is supposed to hear, no meta commentary.',
    messages: [{ role: 'user', content: opener }],
    maxTokens: 200,
  });
}

interface EvaluationResult {
  evaluation: 'strong' | 'partial' | 'weak';
  evaluationNote: string;
  feedback: string;       // short reaction the user hears
  nextQuestion: string;   // the next question (empty if done=true)
  done: boolean;          // true if topic exhausted
}

async function evaluateAndContinue(
  claude: IClaudeClient,
  session: GrillSession,
  answer: string,
): Promise<EvaluationResult> {
  const tonePrompt = session.tone === 'strict'
    ? 'Tech lead grilling style: terse, push back on shallow answers, deepen on weak ones. No coddling.'
    : 'Coach style: warm, give hints if weak, deepen if strong. Use "good" / "almost" / "not quite" naturally.';

  const history = session.turns.slice(-3).map((t, i) =>
    `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer ?? '(unanswered)'}\n${t.evaluationNote ? `[my read: ${t.evaluationNote}]` : ''}`,
  ).join('\n\n');

  const prompt = `${tonePrompt}

Topic: ${session.topic}

Recent Q&A so far:
${history}

The user just answered the last question with: "${answer}"

Decide:
1. evaluation — strong / partial / weak (how well they answered THE LAST question)
2. evaluationNote — one short line (≤12 words) noting WHAT was right or missing
3. feedback — what you say back to the user (≤2 sentences). For weak: a small hint or "not quite, think about X". For strong: brief acknowledgment + drill deeper or pivot.
4. nextQuestion — the next question (≤25 words). Should drill deeper into a weak spot OR pivot to an adjacent branch. Open-ended, what-would-happen-if shape.
5. done — set true if you've genuinely exhausted the topic OR the user is clearly disengaged. Otherwise false.

Output strict JSON: {"evaluation":..,"evaluationNote":..,"feedback":..,"nextQuestion":..,"done":..}`;

  try {
    const result = await claude.structuredCall<EvaluationResult>({
      system: 'You evaluate a developer\'s answer and produce the next grill question. Output strict JSON only via the tool.',
      messages: [{ role: 'user', content: prompt }],
      toolName: 'grill_response',
      toolDescription: 'Evaluate the dev\'s answer and produce the next question.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          evaluation: { type: 'string', enum: ['strong', 'partial', 'weak'] },
          evaluationNote: { type: 'string' },
          feedback: { type: 'string' },
          nextQuestion: { type: 'string' },
          done: { type: 'boolean' },
        },
        required: ['evaluation', 'evaluationNote', 'feedback', 'nextQuestion', 'done'],
      },
    });
    return result;
  } catch {
    // Fallback: end gracefully.
    return {
      evaluation: 'partial',
      evaluationNote: '(eval failed)',
      feedback: 'Got it.',
      nextQuestion: '',
      done: true,
    };
  }
}

async function summarizeGrill(
  claude: IClaudeClient,
  session: GrillSession,
  userQuit: boolean,
): Promise<string> {
  const summary = session.turns.map((t, i) =>
    `Q${i + 1}: ${t.question}\nA${i + 1}: ${t.answer ?? '(no answer)'} → ${t.evaluation ?? '?'}`,
  ).join('\n');

  const lead = userQuit
    ? 'The user ended the grill early.'
    : `We covered ${session.turns.length} questions on ${session.topic}.`;

  try {
    return await claude.streamText({
      system: 'You wrap up a grill session with a brief honest summary the user hears. 2-3 sentences, conversational.',
      messages: [{
        role: 'user',
        content: `${lead}\n\nSession transcript:\n${summary}\n\nWrite a 2-3 sentence wrap-up: what they nailed, what was shaky, what to revisit. Spoken aloud, no markdown.`,
      }],
      maxTokens: 200,
    });
  } catch {
    return userQuit
      ? "Got it, we'll stop there. We can pick this up again whenever you're ready."
      : `Good run. We covered ${session.turns.length} questions on ${session.topic}.`;
  }
}
