export interface HeatmapEntry {
  filePath: string;
  status: 'green' | 'yellow' | 'red';
  changeIntensity: number;
  lastReviewed?: string;
  linesChanged: number;
  familiarityScore: number;
}

export interface HeatmapData {
  repoPath: string;
  entries: HeatmapEntry[];
  generatedAt: string;
}
