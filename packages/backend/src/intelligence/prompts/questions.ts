import type { AreaWithContent } from '@tetherline/shared';

export function buildQuestionPrompt(
  question: string,
  currentArea: AreaWithContent | undefined,
  recentNarration: string,
  repoContext: string,
): string {
  return `The user is in an interactive code review session and has asked a question. Answer it clearly and concisely. If the question is about specific code, reference file paths and line numbers.

${currentArea ? `Currently reviewing area: ${currentArea.name}\n${currentArea.description}` : ''}

Recent narration context:
${recentNarration}

Repository context:
${repoContext}

User's question: ${question}

Answer naturally, as if you're a colleague having a conversation. Keep it focused and actionable.`;
}
