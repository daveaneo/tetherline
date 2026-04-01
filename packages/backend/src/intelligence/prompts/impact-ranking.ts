export function buildImpactRankingPrompt(areas: Array<{ name: string; description: string; significance: string; fileCount: number; commitCount: number }>): string {
  return `Score each area of change on these dimensions (0-100 each):
- Architectural impact: does it change how components connect?
- Risk: does it touch critical paths, lack tests, or introduce breaking changes?
- Conceptual novelty: is this a new pattern, concept, or approach?
- Cross-cutting breadth: how many modules/services does it touch?

Then provide a single overall impact score (weighted: risk 30%, architectural 30%, novelty 20%, breadth 20%) and a one-sentence impact summary.

Areas:
${areas.map((a, i) => `${i + 1}. ${a.name}: ${a.description} (${a.commitCount} commits, ${a.fileCount} files, significance: ${a.significance})`).join('\n')}`;
}

export const IMPACT_RANKING_TOOL = {
  name: 'rank_impact',
  description: 'Rank areas by impact with dimensional scores',
  inputSchema: {
    type: 'object' as const,
    properties: {
      rankings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            areaIndex: { type: 'number' },
            overallImpact: { type: 'number' },
            architecturalImpact: { type: 'number' },
            risk: { type: 'number' },
            conceptualNovelty: { type: 'number' },
            crossCuttingBreadth: { type: 'number' },
            impactSummary: { type: 'string' },
            riskFlags: { type: 'array', items: { type: 'string' } },
          },
          required: ['areaIndex', 'overallImpact', 'impactSummary', 'riskFlags'],
        },
      },
    },
    required: ['rankings'],
  },
};

export interface ImpactRanking {
  areaIndex: number;
  overallImpact: number;
  architecturalImpact?: number;
  risk?: number;
  conceptualNovelty?: number;
  crossCuttingBreadth?: number;
  impactSummary: string;
  riskFlags: string[];
}
