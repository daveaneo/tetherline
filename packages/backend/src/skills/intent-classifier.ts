import type { SkillName, IntentClassification } from '@tetherline/shared';
import type { IClaudeClient } from '../intelligence/client-interface.js';

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
  // Action commands
  'create a ticket': 'create_issue', 'create an issue': 'create_issue', 'file an issue': 'create_issue',
  'open a ticket': 'create_issue', 'create a bug': 'create_issue',
  'share this': 'share_explanation', 'share this explanation': 'share_explanation', 'copy this': 'share_explanation',
  // Export commands
  'export slides': 'export_slides', 'make slides': 'export_slides', 'create a presentation': 'export_slides',
  'export markdown': 'export_markdown', 'make a summary': 'export_markdown', 'write it up': 'export_markdown',
  // Mode toggle commands
  'turn on advisory': 'toggle_advisory_on', 'show concerns': 'toggle_advisory_on', 'show issues': 'toggle_advisory_on',
  'turn off advisory': 'toggle_advisory_off', 'hide concerns': 'toggle_advisory_off',
  'turn on narration': 'toggle_narration_on', 'unmute': 'toggle_narration_on',
  'turn off narration': 'toggle_narration_off', 'mute': 'toggle_narration_off',
  'turn on active learning': 'toggle_activeLearning_on',
  'turn off active learning': 'toggle_activeLearning_off',
  'turn on alerts': 'toggle_alerts_on',
  'turn off alerts': 'toggle_alerts_off',
  // Zoom commands
  'show me the big picture': 'zoom_out', 'show the overview': 'zoom_out',
  'show the code': 'zoom_to_code', 'show the architecture': 'zoom_to_architecture',
  // Exit / back to lobby commands
  'exit': 'exit_session', 'go home': 'exit_session', 'back to lobby': 'exit_session', 'quit': 'exit_session',
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

  constructor(private claude: IClaudeClient) {}

  async classify(utterance: string, context: string): Promise<IntentClassification> {
    // Strip trailing punctuation so "next." and "next!" still match the
    // dictionary's "next" entry. Whitespace + casing are already
    // normalized below.
    const normalized = utterance.toLowerCase().trim().replace(/[.!?,;:]+$/, '');

    // Check for navigation commands first — STRICT EXACT MATCH only.
    // The previous `startsWith(phrase + ' ')` matcher hijacked longer
    // utterances: "skip the boring parts" → navigation:skip; "next,
    // tell me about X" → navigation:next; "back to the basics of how
    // this works" → navigation:previous. Any prefix-style match is a
    // foot-gun because real conversation regularly opens with common
    // command words. Only treat as a deterministic command when the
    // entire utterance is the phrase.
    for (const [phrase, command] of Object.entries(NAVIGATION_PHRASES)) {
      if (normalized === phrase) {
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
- critique: user wants the AI's OPINION on something specific ("is this good", "what do you think of X", "any issues with Y")
- summarize: user wants a BRIEF prose overview ("give me the quick version", "summarize", "tldr") — flat sentences, NOT creative formats
- navigate: user wants to MOVE somewhere in the codebase ("go to", "show me the file", "open")
- teach: user wants to LEARN a concept ("what is", "explain the pattern", "teach me about")
- annotate: user wants to MARK something ("flag this", "remember this", "note")
- create_issue: user wants to CREATE a GitHub issue ("create a ticket", "file an issue", "open a bug")
- share_explanation: user wants to SHARE or COPY the current explanation ("share this", "copy this")
- none: NONE OF THE ABOVE fits cleanly. Use 'none' for:
   • Creative output requests (write a poem, joke, story, haiku, song, rap)
   • Hypotheticals or thought experiments ("what if we...", "imagine that...")
   • Conversational follow-ups that don't restart a task ("that wasn't a poem", "try again with X", "no, more like Y")
   • Meta / chit-chat ("can you hear me", "thanks", "good morning")
   • Anything where forcing a skill match would distort the user's intent
  When you return 'none', the general conversational handler responds freely with the project context. This is OFTEN the right answer — don't force-fit.

Return the skill name, a confidence score from 0 to 1, and any extracted parameters (like file names, component names, format hints, length hints, etc).

Confidence guidance:
- 0.9–1.0: utterance maps cleanly to exactly one skill, no ambiguity.
- 0.7–0.9: skill is likely but some ambiguity. The session manager will execute it but log the lower confidence.
- < 0.7: prefer 'none' over guessing — the general handler will do better than a wrong skill.`,
        messages: [{
          role: 'user',
          content: `Context: ${context}\n\nUser said: "${utterance}"`,
        }],
        toolName: 'classify_intent',
        toolDescription: 'Classify user intent into a skill (or none)',
        inputSchema: {
          type: 'object' as const,
          properties: {
            skillName: {
              type: 'string',
              enum: ['visualize', 'explain', 'compare', 'critique', 'summarize', 'navigate', 'teach', 'annotate', 'create_issue', 'share_explanation', 'none'],
            },
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
      // Fallback: 'none' routes to general conversation. Was 'explain'
      // with confidence 0.5 — but that locked the response into the
      // explain skill's hand-tuned prompt instead of letting the
      // conversational handler do its thing.
      return { skillName: 'none', confidence: 0.5, params: {} };
    }
  }
}
