import type { AreaWithContent, CommitDiff } from '@interactive-reviewer/shared';

export function buildNarrativePrompt(area: AreaWithContent, diffs: CommitDiff[]): string {
  const relevantDiffs = diffs
    .filter(d =>
      area.commitHashes.includes(d.commit.hash) ||
      area.commitHashes.includes(d.commit.shortHash),
    )
    .map(d => ({
      commit: d.commit.shortHash + ': ' + d.commit.message,
      files: d.fileDiffs.map(fd => ({
        path: fd.path,
        diff: fd.hunks.map(h => h.content).join('\n'),
      })),
    }));

  return `Generate a narration script for this area of changes. This will be read aloud via text-to-speech, so write naturally and conversationally.

Break the narration into segments of 1-3 sentences each. Each segment should be a self-contained thought that makes sense when spoken aloud.

For each segment, include a visual cue — what should be displayed on screen while this segment is narrated. Visual cue types:
- "highlight_file": Highlight a specific file in the architecture diagram
- "show_diff": Show a code diff for a specific file
- "show_code": Show a specific code snippet
- "diagram_focus": Zoom/focus on a specific part of the architecture diagram
- "none": No specific visual (used for overview/transition segments)

Area: ${area.name}
Description: ${area.description}
Significance: ${area.significance}

Changes:
${JSON.stringify(relevantDiffs, null, 2)}`;
}

export const NARRATIVE_TOOL = {
  name: 'narration_segments',
  description: 'Generate ordered narration segments with visual cues',
  inputSchema: {
    type: 'object' as const,
    properties: {
      overview: {
        type: 'string',
        description: 'A 1-2 sentence overview of this area, suitable for the area introduction',
      },
      segments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'The narration text (1-3 sentences, conversational)',
            },
            visualCue: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['highlight_file', 'show_diff', 'show_code', 'diagram_focus', 'none'],
                },
                filePath: {
                  type: 'string',
                  description: 'File path for highlight_file, show_diff, or show_code',
                },
                lines: {
                  type: 'array',
                  items: { type: 'number' },
                  description: 'Start and end line numbers for show_code',
                },
                code: {
                  type: 'string',
                  description: 'Code snippet for show_code (if not using lines)',
                },
                language: {
                  type: 'string',
                  description: 'Language for syntax highlighting',
                },
                commitHash: {
                  type: 'string',
                  description: 'Commit hash for show_diff',
                },
                diagramNodeId: {
                  type: 'string',
                  description: 'Node ID for diagram_focus',
                },
              },
              required: ['type'],
            },
          },
          required: ['text', 'visualCue'],
        },
      },
    },
    required: ['overview', 'segments'],
  },
};

export interface NarrativeResult {
  overview: string;
  segments: Array<{
    text: string;
    visualCue: {
      type: 'highlight_file' | 'show_diff' | 'show_code' | 'diagram_focus' | 'none';
      filePath?: string;
      lines?: [number, number];
      code?: string;
      language?: string;
      commitHash?: string;
      diagramNodeId?: string;
    };
  }>;
}
