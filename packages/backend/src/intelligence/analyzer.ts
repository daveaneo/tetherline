import type {
  CommitDiff,
  Area,
  AreaWithContent,
  NarrationSegment,
  DiagramNode,
  DiagramEdge,
  Concern,
} from '@tetherline/shared';
import { v4 as uuid } from 'uuid';
import type { IClaudeClient } from './client-interface.js';
import { buildSystemPrompt } from './prompts/system.js';
import { buildClusteringPrompt, CLUSTERING_TOOL, type ClusteringResult } from './prompts/clustering.js';
import { buildNarrativePrompt, NARRATIVE_TOOL, type NarrativeResult } from './prompts/narrative.js';
import { buildArchitecturePrompt, ARCHITECTURE_TOOL, type ArchitectureResult } from './prompts/architecture.js';
import { buildConcernsPrompt, CONCERNS_TOOL, type ConcernsResult } from './prompts/concerns.js';
import { buildImpactRankingPrompt, IMPACT_RANKING_TOOL, type ImpactRanking } from './prompts/impact-ranking.js';
import { buildQuietWeekPrompt, QUIET_WEEK_TOOL, type QuietWeekResult } from './prompts/quiet-week.js';
import type { ContextComposer } from '../cache/context-composer.js';

export class IntelligenceAnalyzer {
  private claude: IClaudeClient;
  private systemPrompt: string;

  /** Expose the underlying client so adjacent modules (grill.ts, etc.)
   *  can issue ad-hoc LLM calls without wiring a separate adapter. */
  getClient(): IClaudeClient { return this.claude; }

  constructor(
    client: IClaudeClient,
    private context: {
      repoName: string;
      repoPath?: string;
      languages: string[];
      sinceDate: string;
      untilDate: string;
      commitCount: number;
      previousSessionSummary?: string;
      contextComposer?: ContextComposer;
    },
  ) {
    this.claude = client;
    const projectContext = context.contextComposer?.getProjectContext();
    this.systemPrompt = buildSystemPrompt({ ...context, projectContext });
  }

  async clusterCommits(diffs: CommitDiff[], sessionId: string): Promise<Area[]> {
    const prompt = buildClusteringPrompt(diffs);
    const result = await this.claude.structuredCall<ClusteringResult>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      toolName: CLUSTERING_TOOL.name,
      toolDescription: CLUSTERING_TOOL.description,
      inputSchema: CLUSTERING_TOOL.inputSchema,
    });

    return result.areas.map((area, index) => {
      // Map short hashes back to full hashes
      const fullHashes = area.commitHashes.map(shortHash => {
        const match = diffs.find(
          d => d.commit.shortHash === shortHash || d.commit.hash.startsWith(shortHash),
        );
        return match?.commit.hash ?? shortHash;
      });

      // Collect affected files from the matching commits
      const affectedFiles = [...new Set(
        diffs
          .filter(d => fullHashes.includes(d.commit.hash))
          .flatMap(d => d.fileDiffs.map(fd => fd.path)),
      )];

      return {
        id: uuid(),
        sessionId,
        name: area.name,
        description: area.description,
        orderIndex: index,
        commitHashes: fullHashes,
        affectedFiles,
        significance: area.significance,
        theme: area.theme,
      };
    });
  }

  async generateNarrative(area: AreaWithContent, diffs: CommitDiff[]): Promise<NarrationSegment[]> {
    const prompt = buildNarrativePrompt(area, diffs);
    const result = await this.claude.structuredCall<NarrativeResult>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      toolName: NARRATIVE_TOOL.name,
      toolDescription: NARRATIVE_TOOL.description,
      inputSchema: NARRATIVE_TOOL.inputSchema,
      maxTokens: 8192,
    });

    return result.segments.map((seg, index) => ({
      id: uuid(),
      areaId: area.id,
      index,
      text: seg.text,
      visualCue: {
        type: seg.visualCue.type,
        filePath: seg.visualCue.filePath,
        lines: seg.visualCue.lines as [number, number] | undefined,
        code: seg.visualCue.code,
        language: seg.visualCue.language,
        commitHash: seg.visualCue.commitHash,
        diagramNodeId: seg.visualCue.diagramNodeId,
      },
    }));
  }

  async generateArchitecture(
    fileTree: string[],
    areas: Area[],
  ): Promise<{ nodes: DiagramNode[]; edges: DiagramEdge[] }> {
    // Guard against massive repos blowing the 200K token context. Prefer files
    // that are relevant to the areas being discussed, plus a sampling of the
    // rest of the tree. Cap at ~2500 paths which is well under the token cap.
    const MAX_PATHS = 2500;
    const relevantFiles = new Set<string>();
    for (const area of areas) {
      for (const f of area.affectedFiles) relevantFiles.add(f);
    }
    let trimmedTree: string[];
    if (fileTree.length <= MAX_PATHS) {
      trimmedTree = fileTree;
    } else {
      // Always include affected files; top up with a stride sample of the rest.
      const remaining = fileTree.filter(f => !relevantFiles.has(f));
      const budget = MAX_PATHS - relevantFiles.size;
      const stride = Math.max(1, Math.ceil(remaining.length / Math.max(1, budget)));
      const sampled = remaining.filter((_, i) => i % stride === 0).slice(0, budget);
      trimmedTree = [...relevantFiles, ...sampled];
    }
    const prompt = buildArchitecturePrompt(trimmedTree, areas);
    const result = await this.claude.structuredCall<ArchitectureResult>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      toolName: ARCHITECTURE_TOOL.name,
      toolDescription: ARCHITECTURE_TOOL.description,
      inputSchema: ARCHITECTURE_TOOL.inputSchema,
    });

    // Assign positions using a simple grid layout (ELKjs will re-layout on the frontend)
    const nodes: DiagramNode[] = result.nodes.map((node, i) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      filePath: node.filePath,
      parentId: node.parentId,
      zoomLevel: node.zoomLevel,
      collapsed: node.zoomLevel === 1, // L1 nodes start collapsed
      position: { x: (i % 5) * 250, y: Math.floor(i / 5) * 150 },
      data: { label: node.label, type: node.type, filePath: node.filePath },
    }));

    const edges: DiagramEdge[] = result.edges.map((edge, i) => ({
      id: `e-${i}`,
      source: edge.source,
      target: edge.target,
      label: edge.label,
      type: edge.type,
    }));

    return { nodes, edges };
  }

  async detectConcerns(diffs: CommitDiff[], sessionId: string): Promise<Concern[]> {
    const prompt = buildConcernsPrompt(diffs);
    const result = await this.claude.structuredCall<ConcernsResult>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      toolName: CONCERNS_TOOL.name,
      toolDescription: CONCERNS_TOOL.description,
      inputSchema: CONCERNS_TOOL.inputSchema,
    });

    return result.concerns.map(concern => ({
      id: uuid(),
      sessionId,
      severity: concern.severity,
      category: concern.category,
      title: concern.title,
      description: concern.description,
      affectedFiles: concern.affectedFiles,
      commitHashes: concern.commitHashes,
      codeReferences: [],
      acknowledged: false,
    }));
  }

  async rankByImpact(areas: Area[]): Promise<ImpactRanking[]> {
    const prompt = buildImpactRankingPrompt(areas.map(a => ({
      name: a.name,
      description: a.description,
      significance: a.significance,
      fileCount: a.affectedFiles.length,
      commitCount: a.commitHashes.length,
    })));
    const result = await this.claude.structuredCall<{ rankings: ImpactRanking[] }>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      toolName: IMPACT_RANKING_TOOL.name,
      toolDescription: IMPACT_RANKING_TOOL.description,
      inputSchema: IMPACT_RANKING_TOOL.inputSchema,
    });
    return result.rankings;
  }

  async generateQuietWeekSuggestion(repoName: string, weakAreas: Array<{ name: string; percentage: number }>): Promise<QuietWeekResult> {
    const prompt = buildQuietWeekPrompt(repoName, weakAreas);
    return this.claude.structuredCall<QuietWeekResult>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      toolName: QUIET_WEEK_TOOL.name,
      toolDescription: QUIET_WEEK_TOOL.description,
      inputSchema: QUIET_WEEK_TOOL.inputSchema,
    });
  }

  async answerQuestion(question: string, context: string): Promise<string> {
    let enrichedContext = context;
    if (this.context.contextComposer) {
      const cached = this.context.contextComposer.compose({ type: 'question', question, tokenBudget: 1000 });
      enrichedContext = cached + '\n\n' + context;
    }
    return this.claude.streamText({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: `${enrichedContext}\n\nQuestion: ${question}` }],
    });
  }

  /** Direct structured call — useful for standalone prompts like project overview. */
  async structuredCallDirect<T>(params: {
    prompt: string;
    toolName: string;
    toolDescription: string;
    inputSchema: Record<string, unknown>;
  }): Promise<T> {
    return this.claude.structuredCall<T>({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: params.prompt }],
      toolName: params.toolName,
      toolDescription: params.toolDescription,
      inputSchema: params.inputSchema,
    });
  }

  async generateProposal(areas: Area[], entryMode: string, languages: string[]): Promise<string> {
    if (entryMode === 'explore') {
      const areaNames = areas.slice(0, 5).map(a => a.name).join(', ');
      return `Here's your codebase. I can see ${areas.length} main areas: ${areaNames}. What would you like to explore?`;
    }
    if (entryMode === 'onboarding') {
      const stats = `${areas.length} key area${areas.length !== 1 ? 's' : ''}, primarily ${languages.slice(0, 3).join(', ') || 'mixed languages'}`;
      const prompt = `Generate a short, warm welcome message for a developer starting an onboarding program for this codebase. The project has ${stats}. Mention that we'll go through a structured multi-day program to build understanding progressively. Keep it to 2-3 sentences, spoken aloud. Do not use bullet points or markdown.`;
      return this.claude.streamText({
        system: this.systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
      });
    }
    if (entryMode === 'full_walkthrough') {
      const stats = `${areas.length} key area${areas.length !== 1 ? 's' : ''}, primarily ${languages.slice(0, 3).join(', ') || 'mixed languages'}`;
      const prompt = `Generate a short, warm proposal message for a full walkthrough code review. The project has ${stats}. The areas are: ${areas.map(a => a.name).join(', ')}. Suggest starting with the big picture and working into the components. Ask if that sounds good or if there's something specific to see first. Keep it to 2-3 sentences, spoken aloud. Do not use bullet points or markdown.`;
      return this.claude.streamText({
        system: this.systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 300,
      });
    }

    // Updates mode
    const biggest = areas[0];
    const prompt = `Generate a short, warm proposal message for a code review session. I found ${areas.length} area${areas.length !== 1 ? 's' : ''} of change. The biggest area is "${biggest?.name ?? 'unknown'}". The other areas are: ${areas.slice(1).map(a => a.name).join(', ') || 'none'}. Suggest starting with the biggest area. Ask if the user wants to go in that order or prefers something different. Keep it to 2-3 sentences, spoken aloud. Do not use bullet points or markdown.`;
    return this.claude.streamText({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 300,
    });
  }

  async generateSessionSummary(areas: Area[], concerns: Concern[]): Promise<string> {
    const prompt = `Summarize this week's code review session in 2-3 sentences for the "Previously on..." recap next week.

Areas reviewed:
${areas.map(a => `- ${a.name} (${a.significance}): ${a.description}`).join('\n')}

Concerns flagged: ${concerns.length}
${concerns.map(c => `- [${c.severity}] ${c.title}`).join('\n')}`;

    return this.claude.streamText({
      system: this.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 300,
    });
  }
}
