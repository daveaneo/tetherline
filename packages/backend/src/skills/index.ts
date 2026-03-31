import { SkillRegistry } from './registry.js';
import { explainSkill } from './explain.js';
import { visualizeSkill } from './visualize.js';
import { compareSkill } from './compare.js';
import { critiqueSkill } from './critique.js';
import { summarizeSkill } from './summarize.js';
import { navigateSkill } from './navigate.js';
import { teachSkill } from './teach.js';
import { annotateSkill } from './annotate.js';

export function createSkillRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register(explainSkill);
  registry.register(visualizeSkill);
  registry.register(compareSkill);
  registry.register(critiqueSkill);
  registry.register(summarizeSkill);
  registry.register(navigateSkill);
  registry.register(teachSkill);
  registry.register(annotateSkill);
  return registry;
}

export { SkillRegistry } from './registry.js';
export { IntentClassifier } from './intent-classifier.js';
