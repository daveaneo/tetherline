import type { SkillName, SkillResult } from '@tetherline/shared';
import type { AreaWithContent } from '@tetherline/shared';
import type { IntelligenceAnalyzer } from '../intelligence/analyzer.js';
import type { ContextComposer } from '../cache/context-composer.js';
import type { ContextCacheRepository } from '../db/repositories/context-cache-repo.js';
import type { DiagramCacheRepository } from '../db/repositories/diagram-cache-repo.js';

export interface SkillContext {
  currentArea?: AreaWithContent;
  currentFile?: string;
  zoomLevel: number;
  repoPath: string;
  fileTree: string[];
  areas: AreaWithContent[];
  analyzer: IntelligenceAnalyzer;
  contextComposer?: ContextComposer;
  /** Cached module/file summaries — lets visualize ground a flow in real
   *  files + import edges, and serve a pre-authored flow from the cache. */
  cacheRepo?: ContextCacheRepository;
  diagramRepo?: DiagramCacheRepository;
}

/** Backend-side extension of the shared SkillResult: a skill may hand the
 *  manager a LIVE token stream instead of a complete narration string, so
 *  sentences speak as they generate. NEVER serialized — the manager strips
 *  it before emitting skill:result over the wire. */
export interface BackendSkillResult extends SkillResult {
  narrationStream?: import('../intelligence/llm/types.js').LLMStreamHandle;
}

export interface Skill {
  name: SkillName;
  description: string;
  execute: (context: SkillContext, params: Record<string, string>) => Promise<BackendSkillResult>;
}

export class SkillRegistry {
  private skills = new Map<SkillName, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: SkillName): Skill | undefined {
    return this.skills.get(name);
  }

  async execute(name: SkillName, context: SkillContext, params: Record<string, string>): Promise<BackendSkillResult> {
    const skill = this.skills.get(name);
    if (!skill) throw new Error(`Unknown skill: ${name}`);
    return skill.execute(context, params);
  }

  listSkills(): Array<{ name: string; description: string }> {
    return [...this.skills.values()].map(s => ({ name: s.name, description: s.description }));
  }
}
