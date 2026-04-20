import type { SkillName, SkillResult } from '@tetherline/shared';
import type { AreaWithContent } from '@tetherline/shared';
import type { IntelligenceAnalyzer } from '../intelligence/analyzer.js';
import type { ContextComposer } from '../cache/context-composer.js';

export interface SkillContext {
  currentArea?: AreaWithContent;
  currentFile?: string;
  zoomLevel: number;
  repoPath: string;
  fileTree: string[];
  areas: AreaWithContent[];
  analyzer: IntelligenceAnalyzer;
  contextComposer?: ContextComposer;
}

export interface Skill {
  name: SkillName;
  description: string;
  execute: (context: SkillContext, params: Record<string, string>) => Promise<SkillResult>;
}

export class SkillRegistry {
  private skills = new Map<SkillName, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: SkillName): Skill | undefined {
    return this.skills.get(name);
  }

  async execute(name: SkillName, context: SkillContext, params: Record<string, string>): Promise<SkillResult> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill.execute(context, params);
  }

  listSkills(): Array<{ name: string; description: string }> {
    return [...this.skills.values()].map(s => ({ name: s.name, description: s.description }));
  }
}
