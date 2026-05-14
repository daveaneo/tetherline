/**
 * grill_me skill — kicks off an adaptive Socratic grill on a topic.
 *
 * The skill itself just produces the FIRST question and a side effect:
 * it tells the session manager that grill mode is active. Subsequent
 * user utterances are handled by the manager's grill loop (see
 * activeGrill state in session/manager.ts), not by re-classifying each
 * answer as a fresh skill request.
 *
 * Tone defaults to 'coach' (collaborative); the user can ask for
 * 'strict' mode by saying "grill me hard" / "grill me strict" — the
 * classifier surfaces that hint via params.tone.
 */
import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';

export const grillMeSkill: Skill = {
  name: 'grill_me',
  description: 'Open an adaptive Socratic grill — AI quizzes the user on a topic, drilling into weak spots',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const topic =
      params.topic
        ?? params.target
        ?? params.subject
        ?? context.currentArea?.name
        ?? 'this project';
    const tone: 'coach' | 'strict' =
      /^(strict|hard|tough|brutal)$/i.test(params.tone ?? '') ||
      /^(strict|hard|tough|brutal)$/i.test(params.style ?? '')
        ? 'strict'
        : 'coach';

    // The actual question generation + state setup happens in the
    // session manager (it owns the grill state machine and needs to
    // reroute subsequent utterances). The skill just carries the
    // params through; the manager picks up `_action: 'start_grill'`
    // from visualPayload and runs.
    return {
      skillName: 'grill_me',
      type: 'explanation',
      narration: '', // intentionally empty — manager generates the first question via grill.ts
      visualPayload: {
        _action: 'start_grill',
        topic,
        tone,
      },
    };
  },
};
