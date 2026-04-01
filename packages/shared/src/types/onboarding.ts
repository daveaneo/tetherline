import type { VisualLayer } from './visual-layer.js';

export interface OnboardingProgram {
  id: string;
  repoPath: string;
  name: string;
  totalDays: number;
  days: OnboardingDay[];
  createdAt: string;
}

export interface OnboardingDay {
  dayNumber: number;
  title: string;
  description: string;
  targetLayer: VisualLayer;
  topics: string[];
  estimatedMinutes: number;
  completed: boolean;
  completedAt?: string;
}

export interface OnboardingProgress {
  programId: string;
  currentDay: number;
  completedDays: number[];
  startedAt: string;
  lastActiveAt: string;
}
