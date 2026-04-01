export interface SessionModes {
  narration: boolean;
  activeLearning: boolean;
  advisory: boolean;
  alerts: boolean;
}

export const DEFAULT_MODES: SessionModes = {
  narration: true,
  activeLearning: false,
  advisory: false,
  alerts: true,
};

export type ModeKey = keyof SessionModes;

export type EntryMode = 'full_walkthrough' | 'updates' | 'onboarding' | 'explore';
