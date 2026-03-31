import type { SkillName, IntentClassification } from '@interactive-reviewer/shared';
import type { ClaudeClient } from '../intelligence/claude-client.js';

// Navigation commands that don't need AI classification
const NAVIGATION_PHRASES: Record<string, string> = {
  'next': 'next', 'move on': 'next', 'continue': 'next',
  'go back': 'previous', 'previous': 'previous', 'back': 'previous',
  'skip': 'skip', 'skip this': 'skip',
  'pause': 'pause', 'stop': 'pause',
  'resume': 'resume', 'go': 'resume', 'play': 'resume',
  'go deeper': 'dive_deeper', 'dive deeper': 'dive_deeper', 'more detail': 'dive_deeper', 'tell me more': 'dive_deeper',
  'zoom out': 'zoom_out', 'go up': 'zoom_out',
  'back to the tour': 'resume_tour', 'resume tour': 'resume_tour', 'resume the tour': 'resume_tour',
  'back to the walkthrough': 'resume_tour', 'resume walkthrough': 'resume_tour',
  "let's continue the tour": 'resume_tour', "where were we": 'resume_tour',
};

// Correction phrases that trigger re-classification
const CORRECTION_PHRASES = [
  "that's not what i meant",
  "no not that",
  "i meant",
  "actually i wanted",
  "not that",
  "wrong one",
  "no i want",
];

export class IntentClassifier {
  private lastClassification: IntentClassification | null = null;
  private lastUtterance: string = '';

  constructor(private claude: ClaudeClient) {}

  async classify(utterance: string, context: string): Promise<IntentClassification> {
    const normalized = utterance.toLowerCase().trim();

    // Check for navigation commands first
    for (const [phrase, command] of Object.entries(NAVIGATION_PHRASES)) {
      if (normalized === phrase || normalized.startsWith(phrase + ' ')) {
        return { skillName: 'navigation', confidence: 1.0, params: {}, navigationCommand: command };
      }
    }

    // Check for correction phrases
    const isCorrection = CORRECTION_PHRASES.some(p => normalized.includes(p));
    if (isCorrection && this.lastClassification) {
      return this.reclassify(normalized, context);
    }

    // Use Claude for intent classification
    const classification = await this.classifyWithAI(utterance, context);
    this.lastClassification = classification;
    this.lastUtterance = utterance;
    return classification;
  }

  private async reclassify(correction: string, context: string): Promise<IntentClassification> {
    const prompt = `The user said: "${this.lastUtterance}"
I classified this as skill "${this.lastClassification?.skillName}" but the user corrected me with: "${correction}"

What did they actually want? Classify their original intent correctly.

${context}`;

    return this.classifyWithAI(prompt, context);
  }

  private async classifyWithAI(utterance: string, context: string): Promise<IntentClassification> {
    try {
      const result = await this.claude.structuredCall<{
        skillName: string;
        confidence: number;
        params: Record<string, string>;
      }>({
        system: `You are an intent classifier for a code review tool. The user is talking during an interactive code review session. Classify their utterance into one of these skills:

- visualize: user wants to SEE a diagram or visual representation ("show me", "draw", "what does X look like")
- explain: user wants something EXPLAINED ("what does this do", "why", "how does X work")
- compare: user wants to see DIFFERENCES ("how did this change", "before and after", "diff")
- critique: user wants the AI's OPINION ("is this good", "what do you think", "any issues")
- summarize: user wants a BRIEF overview ("give me the quick version", "summarize", "tldr")
- navigate: user wants to MOVE somewhere in the codebase ("go to", "show me the file", "open")
- teach: user wants to LEARN a concept ("what is", "explain the pattern", "teach me about")
- annotate: user wants to MARK something ("flag this", "remember this", "note")

Return the skill name, a confidence score from 0 to 1, and any extracted parameters (like file names, component names, etc).`,
        messages: [{
          role: 'user',
          content: `Context: ${context}\n\nUser said: "${utterance}"`,
        }],
        toolName: 'classify_intent',
        toolDescription: 'Classify user intent into a skill',
        inputSchema: {
          type: 'object' as const,
          properties: {
            skillName: { type: 'string', enum: ['visualize', 'explain', 'compare', 'critique', 'summarize', 'navigate', 'teach', 'annotate'] },
            confidence: { type: 'number', description: 'Confidence score from 0 to 1' },
            params: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extracted parameters' },
          },
          required: ['skillName', 'confidence', 'params'],
        },
        maxTokens: 256,
      });

      return {
        skillName: result.skillName as SkillName,
        confidence: result.confidence,
        params: result.params,
      };
    } catch {
      // Fallback: treat as explain
      return { skillName: 'explain', confidence: 0.5, params: {} };
    }
  }
}
