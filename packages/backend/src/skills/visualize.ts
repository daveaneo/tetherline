import type { Skill, SkillContext } from './registry.js';
import type { SkillResult } from '@tetherline/shared';
import { constraintInstruction } from './params-helper.js';
import { authorFlow } from '../intelligence/flow-author.js';
import { buildFlowEvidence } from '../intelligence/flow-evidence.js';

export const visualizeSkill: Skill = {
  name: 'visualize',
  description: 'Author a fresh diagram that answers a visual question (pipeline / flow / architecture)',
  async execute(context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const target = params.target ?? params.subject ?? params.scope ?? 'the current code';

    // Cache-first: a pre-authored flow for this module is served instantly
    // (zero LLM calls). The warmer pre-builds flows for the top modules.
    const cached = readCachedFlow(context, target);
    if (cached) return cached;

    const projectContext = [
      `Repo: ${context.repoPath}.`,
      `Top-level areas: ${context.areas.map(a => `${a.name} — ${a.description ?? ''}`.trim()).join('; ') || 'unknown'}.`,
      context.currentArea ? `Currently focused area: ${context.currentArea.name}.` : '',
    ].filter(Boolean).join(' ');

    const brevity = constraintInstruction(
      params,
      ['target', 'subject', 'scope'],
      'Spoken naturally; refer to nodes by their labels so the words and the picture agree.',
    );

    // Ground the authoring in the target module's real files + import edges,
    // when the cache knows them. No module match → ungrounded (as before).
    const modules = context.cacheRepo?.getModulesForRepo(context.repoPath) ?? [];
    const evidence = modules.length
      ? buildFlowEvidence(target, {
          repoPath: context.repoPath,
          modules: modules.map(m => ({ modulePath: m.modulePath, keyFiles: m.keyFiles })),
        })
      : null;

    const authored = await authorFlow({ target, projectContext, brevity, evidence, analyzer: context.analyzer });

    if (authored) {
      const diagram = {
        scope: `authored/${target.toLowerCase().replace(/\s+/g, '-').slice(0, 40)}`,
        view: 'logic' as const,
        title: authored.title || target,
        subtitle: authored.subtitle,
        nodes: authored.nodes,
        edges: authored.edges,
      };
      return {
        skillName: 'visualize',
        type: 'diagram',
        narration: authored.narration,
        // `kind` drives the frontend layout (pipeline/sequence → layered L→R).
        visualPayload: { target, kind: authored.kind, diagram },
      };
    }

    // Voice north-star: never go silent. Fall back to narrate-only.
    const narration = await context.analyzer.answerQuestion(
      `Describe the visual structure of ${target} for a diagram. What are the key components and how do they connect? Keep it brief — this will be narrated aloud.`,
      `Repo: ${context.repoPath}. Areas: ${context.areas.map(a => a.name).join(', ')}.`,
      { params, currentFile: context.currentFile },
    );
    return {
      skillName: 'visualize',
      type: 'diagram',
      narration,
      visualPayload: { target },
    };
  },
};

/** Serve a pre-authored flow diagram from the cache (warm-time) when the
 *  target resolves to a module that has one — instant, no LLM. */
function readCachedFlow(context: SkillContext, target: string): SkillResult | null {
  if (!context.diagramRepo || !context.cacheRepo) return null;
  const modules = context.cacheRepo.getModulesForRepo(context.repoPath);
  if (modules.length === 0) return null;
  const ev = buildFlowEvidence(target, {
    repoPath: context.repoPath,
    modules: modules.map(m => ({ modulePath: m.modulePath, keyFiles: m.keyFiles })),
  });
  if (!ev) return null;
  const scope = `flow/module/${ev.moduleName}`;
  const row = context.diagramRepo.get(context.repoPath, scope, 'logic');
  if (!row || !row.nodes || row.nodes.length < 3) return null;
  return {
    skillName: 'visualize',
    type: 'diagram',
    narration: (row.narration ?? `Here's the ${ev.moduleName} workflow.`).trim(),
    visualPayload: {
      target,
      kind: 'pipeline',
      diagram: {
        scope: row.scope,
        view: 'logic',
        title: row.title,
        subtitle: row.subtitle,
        nodes: row.nodes,
        edges: row.edges,
      },
    },
  };
}
