export type UnderstandingLevel = 'project' | 'architecture' | 'component' | 'file' | 'code';
export type UnderstandingStatus = 'not_started' | 'partial' | 'understood' | 'stale';

export interface UnderstandingItem {
  id: string;
  repoPath: string;
  layer: UnderstandingLevel;
  itemId: string;
  itemName: string;
  parentId?: string;
  status: UnderstandingStatus;
  lastReviewedAt?: string;
  staleSince?: string;
}

export interface UnderstandingLayer {
  level: UnderstandingLevel;
  percentage: number;
  total: number;
  understood: number;
  stale: number;
}

export interface UnderstandingState {
  repoPath: string;
  layers: UnderstandingLayer[];
  overallPercentage: number;
  lastUpdated: string;
}
