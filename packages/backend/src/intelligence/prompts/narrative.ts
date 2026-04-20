import type { AreaWithContent, CommitDiff } from '@tetherline/shared';

// Hard cap per diff hunk so narrative prompts don't blow the 200K token ceiling
// on large refactors. ~8KB per file diff ≈ 2K tokens. Covers the overwhelming
// majority of real-world cases and truncation is clearly signposted to the LLM.
const PER_FILE_DIFF_CHAR_CAP = 8_000;
const PER_COMMIT_FILES_CAP = 12;
const TOTAL_PROMPT_CHAR_CAP = 120_000; // ~30K tokens — leaves generous headroom.

export function buildNarrativePrompt(area: AreaWithContent, diffs: CommitDiff[]): string {
  const relevantDiffs = diffs
    .filter(d =>
      area.commitHashes.includes(d.commit.hash) ||
      area.commitHashes.includes(d.commit.shortHash),
    )
    .map(d => ({
      commit: d.commit.shortHash + ': ' + d.commit.message,
      files: d.fileDiffs.slice(0, PER_COMMIT_FILES_CAP).map(fd => {
        const full = fd.hunks.map(h => h.content).join('\n');
        const truncated = full.length > PER_FILE_DIFF_CHAR_CAP
          ? full.slice(0, PER_FILE_DIFF_CHAR_CAP) + `\n… (+${full.length - PER_FILE_DIFF_CHAR_CAP} chars truncated)`
          : full;
        return { path: fd.path, diff: truncated };
      }),
      truncatedFiles: Math.max(0, d.fileDiffs.length - PER_COMMIT_FILES_CAP),
    }));

  return `Generate a narration script for this area of changes. You are a warm, knowledgeable guide — think of yourself as a senior engineer walking a colleague through the code at a whiteboard. Your words will be spoken aloud via text-to-speech.

IMPORTANT: Lead each area's narration with WHY it matters, not just what changed.
The first segment should explain the impact: "This matters because..."
The second segment should describe the before/after: "Previously the system did X. Now it does Y."
Only then dive into specific code changes.
Don't just describe diffs — explain the developer's intent and the downstream effects.

Write each segment as natural speech: use transitions like "Let me show you...", "This is interesting because...", "One thing to note here...". Never use bullet points, markdown, or numbered lists. When something is complex, say so: "This part is a bit involved, so let me walk through it step by step." When something is simple, move quickly: "This is pretty straightforward —". Be opinionated: "I think this approach is solid because..." or "Honestly, this could be cleaner." Reference what the viewer can see: "If you look at the code panel..." or "Over on the left you can see..."

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
${capJson(JSON.stringify(relevantDiffs, null, 2), TOTAL_PROMPT_CHAR_CAP)}`;
}

function capJson(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n\n… (changes payload truncated — ${text.length - max} chars omitted to fit model context)`;
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
