export type TTSProvider = 'openai' | 'browser';

export interface Settings {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  ttsProvider: TTSProvider;
  ttsVoice: string;
  defaultModes: {
    narration: boolean;
    activeLearning: boolean;
    advisory: boolean;
    alerts: boolean;
  };
  sinceDays: number;
  autoOpen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ttsProvider: 'openai',
  ttsVoice: 'coral',
  defaultModes: {
    narration: true,
    activeLearning: false,
    advisory: false,
    alerts: true,
  },
  sinceDays: 7,
  autoOpen: true,
};
