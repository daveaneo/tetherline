export type VoiceCommand =
  | 'next' | 'previous' | 'dive_deeper' | 'skip'
  | 'pause' | 'resume' | 'show_concerns';

export type VoiceCommandHandler = (command: VoiceCommand) => void;
export type QuestionHandler = (question: string) => void;
export type UtteranceHandler = (text: string) => void;

const COMMAND_PHRASES: Record<string, VoiceCommand> = {
  'next': 'next',
  'move on': 'next',
  'continue': 'next',
  'go back': 'previous',
  'previous': 'previous',
  'back': 'previous',
  'dive deeper': 'dive_deeper',
  'more detail': 'dive_deeper',
  'tell me more': 'dive_deeper',
  'skip': 'skip',
  'skip this': 'skip',
  'pause': 'pause',
  'stop': 'pause',
  'resume': 'resume',
  'go': 'resume',
  'play': 'resume',
  'show concerns': 'show_concerns',
  'any issues': 'show_concerns',
  'concerns': 'show_concerns',
};

// Web Speech API types are not fully available in all TypeScript lib versions.
// We use `any` for the recognition instance and augment Window for the constructors.
interface SpeechRecognitionConstructor {
  new (): any;
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export class VoiceCommandRecognizer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private recognition: any | null = null;
  private isListening = false;
  onCommand: VoiceCommandHandler | null = null;
  onQuestion: QuestionHandler | null = null;
  onUtterance: UtteranceHandler | null = null;
  onSpeechStart: (() => void) | null = null;
  onSpeechEnd: (() => void) | null = null;

  constructor() {
    const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      console.warn('Speech recognition not supported in this browser');
      return;
    }

    this.recognition = new SpeechRecognitionCtor();
    this.recognition.continuous = true;
    this.recognition.interimResults = false;
    this.recognition.lang = 'en-US';

    this.recognition.onspeechstart = () => {
      this.onSpeechStart?.();
    };

    this.recognition.onspeechend = () => {
      this.onSpeechEnd?.();
    };

    this.recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript.trim().toLowerCase();

      // Check for local navigation commands first (fast, no AI needed)
      for (const [phrase, command] of Object.entries(COMMAND_PHRASES)) {
        if (transcript.includes(phrase)) {
          this.onCommand?.(command);
          return;
        }
      }

      // Send everything else as a unified utterance for AI-powered intent classification
      if (this.onUtterance) {
        this.onUtterance(transcript);
        return;
      }

      // Legacy fallback: check for question intent
      if (transcript.startsWith('ask ') || transcript.startsWith('question ')) {
        const question = transcript.replace(/^(ask|question)\s*/i, '');
        if (question) this.onQuestion?.(question);
        return;
      }

      // Legacy fallback: treat longer utterances as questions
      if (transcript.split(' ').length > 3) {
        this.onQuestion?.(transcript);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.error('Speech recognition error:', event.error);
      }
    };

    this.recognition.onend = () => {
      // Auto-restart if we should be listening
      if (this.isListening) {
        try {
          this.recognition.start();
        } catch {
          // Already started
        }
      }
    };
  }

  start() {
    if (!this.recognition) return;
    this.isListening = true;
    try {
      this.recognition.start();
    } catch {
      // Already started
    }
  }

  stop() {
    if (!this.recognition) return;
    this.isListening = false;
    this.recognition.stop();
  }

  isSupported(): boolean {
    return this.recognition !== null;
  }
}
