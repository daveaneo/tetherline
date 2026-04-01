export type VoiceCommand =
  | 'next' | 'previous' | 'dive_deeper' | 'skip'
  | 'pause' | 'resume' | 'show_concerns'
  | 'export_slides' | 'export_markdown'
  | 'toggle_narration_off' | 'toggle_narration_on'
  | 'toggle_advisory_off' | 'toggle_advisory_on'
  | 'toggle_activeLearning_off' | 'toggle_activeLearning_on'
  | 'toggle_alerts_off' | 'toggle_alerts_on'
  | 'exit_session';

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
  // Export commands
  'export slides': 'export_slides',
  'make slides': 'export_slides',
  'create a presentation': 'export_slides',
  'export markdown': 'export_markdown',
  'make a summary': 'export_markdown',
  'write it up': 'export_markdown',
  // Mode toggle commands
  'turn on narration': 'toggle_narration_on',
  'unmute': 'toggle_narration_on',
  'turn off narration': 'toggle_narration_off',
  'mute': 'toggle_narration_off',
  'turn on advisory': 'toggle_advisory_on',
  'show issues': 'toggle_advisory_on',
  'turn off advisory': 'toggle_advisory_off',
  'hide concerns': 'toggle_advisory_off',
  'turn on active learning': 'toggle_activeLearning_on',
  'turn off active learning': 'toggle_activeLearning_off',
  'turn on alerts': 'toggle_alerts_on',
  'turn off alerts': 'toggle_alerts_off',
  // Exit / back to lobby
  'exit': 'exit_session',
  'go home': 'exit_session',
  'back to lobby': 'exit_session',
  'quit': 'exit_session',
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
  onError: ((error: string) => void) | null = null;
  onAudioStart: (() => void) | null = null;
  onStateChange: ((state: string) => void) | null = null;
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

    this.recognition.onaudiostart = () => {
      this.onAudioStart?.();
      this.onStateChange?.('audio_started');
    };

    this.recognition.onaudioend = () => {
      this.onStateChange?.('audio_ended');
    };

    this.recognition.onspeechstart = () => {
      this.onSpeechStart?.();
      this.onStateChange?.('speech_detected');
    };

    this.recognition.onspeechend = () => {
      this.onSpeechEnd?.();
      this.onStateChange?.('speech_ended');
    };

    this.recognition.onnomatch = () => {
      this.onStateChange?.('no_match');
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
        this.onError?.(event.error);
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
