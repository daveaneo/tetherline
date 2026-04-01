export type TTSProvider = 'openai' | 'browser';

export interface DigestConfig {
  enabled: boolean;
  schedule: string; // cron expression, default "0 8 * * 1" (Monday 8am)
  delivery: 'app' | 'email' | 'slack';
  emailTo?: string;
  slackWebhookUrl?: string;
}

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
  digest?: DigestConfig;
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
