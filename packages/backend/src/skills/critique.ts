import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';

type Severity = 'high' | 'medium' | 'low';

export interface CritiqueConcern {
  /** Short headline, ≤ 8 words. */
  title: string;
  severity: Severity;
  /** Files/modules/areas this concern is about, named the way they
   *  appear in the codebase. Drives the (active-concern-only) tint. */
  targets: string[];
  /** 3-4 sentence spoken treatment of this one concern. */
  detail: string;
}

interface RankedCritique {
  concerns: CritiqueConcern[];
}

// Lower rank sorts first → high severity leads the list.
const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

const RANKED_CRITIQUE_SCHEMA = {
  type: 'object' as const,
  properties: {
    concerns: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short concern headline, at most 8 words' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          targets: {
            type: 'array',
            items: { type: 'string' },
            description: 'Files/modules/areas this concern is about, named as in the codebase',
          },
          detail: { type: 'string', description: '3-4 sentence spoken explanation of this concern' },
        },
        required: ['title', 'severity', 'detail'],
      },
    },
  },
  required: ['concerns'],
};

export const critiqueSkill: Skill = {
  name: 'critique',
  description: "Give the AI's opinion on code quality, design, or approach",
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.subject ?? 'the current code';
    const ctx = `Current area: ${context.currentArea?.name ?? 'none'}. Repo: ${context.repoPath}.`;

    try {
      const detailBrevity = constraintInstruction(
        params,
        ['target', 'subject'],
        'Each detail is 3-4 sentences max, constructive and conversational, spoken aloud as natural prose (no bullets, no preamble).',
      );
      const prompt = [
        `Critically review ${target}. Identify up to 5 distinct, genuine concerns ranked by severity (most serious first).`,
        `For each concern give: a short title, a severity (high/medium/low), the specific files/modules/areas it is about (targets, named as they appear in the codebase), and a spoken detail.`,
        detailBrevity,
        `Only flag real concerns — never manufacture problems. If the code is genuinely solid, return a single low-severity concern that honestly says so and names what is strong.`,
        ctx,
      ].join(' ');

      const out = await context.analyzer.structuredCallDirect<RankedCritique>({
        prompt,
        toolName: 'ranked_critique',
        toolDescription: 'Return up to 5 severity-ranked concerns, each with the code it is about and a spoken detail.',
        inputSchema: RANKED_CRITIQUE_SCHEMA,
      });

      const concerns = (out.concerns ?? [])
        .filter(c => c && typeof c.title === 'string' && typeof c.detail === 'string' && c.title.trim() && c.detail.trim())
        .map(c => ({
          title: c.title.trim(),
          severity: (['high', 'medium', 'low'].includes(c.severity) ? c.severity : 'medium') as Severity,
          targets: Array.isArray(c.targets) ? c.targets.filter(t => typeof t === 'string' && t.trim()) : [],
          detail: c.detail.trim(),
        }))
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        .slice(0, 5);

      if (concerns.length === 0) throw new Error('critique returned no usable concerns');

      return {
        skillName: 'critique',
        type: 'explanation',
        // Voice speaks the top concern; the rest are navigable in the
        // card without any further LLM round-trip.
        narration: concerns[0].detail,
        visualPayload: { target, concerns, activeIndex: 0 },
      };
    } catch {
      // Voice north-star: a critique must never go silent. Fall back to
      // the prior single-prose path. With no `concerns`, the frontend
      // uses the deterministic narration string-match for the tint.
      const narration = await context.analyzer.answerQuestion(
        [
          `Give your honest assessment of ${target}.`,
          constraintInstruction(
            params,
            ['target', 'subject'],
            "3-4 sentences max: ONE thing that's good, ONE thing that worries you, ONE specific risk. Skip preamble. Be constructive and conversational.",
          ),
          'Spoken aloud — natural prose, no bullets.',
        ].join(' '),
        ctx,
      );
      return {
        skillName: 'critique',
        type: 'explanation',
        narration,
        visualPayload: { target },
      };
    }
  },
};
