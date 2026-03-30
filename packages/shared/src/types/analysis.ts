export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: FileChange[];
}

export interface FileChange {
  path: string;
  insertions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  language: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface CommitDiff {
  commit: CommitInfo;
  fileDiffs: FileDiff[];
  wasTruncated: boolean;
}

export interface Area {
  id: string;
  sessionId: string;
  name: string;
  description: string;
  orderIndex: number;
  commitHashes: string[];
  affectedFiles: string[];
  significance: 'major' | 'minor' | 'maintenance';
}

export interface AreaWithContent extends Area {
  narrativeText?: string;
  narrationSegments: NarrationSegment[];
  architectureNodes: DiagramNode[];
  architectureEdges: DiagramEdge[];
  deepDiveGenerated: boolean;
  deepDiveContent?: NarrationSegment[];
  reviewed: boolean;
  reviewedAt?: string;
}

export interface NarrationSegment {
  id: string;
  areaId: string;
  index: number;
  text: string;
  visualCue: VisualCue;
  speakerNotes?: string;
}

export interface VisualCue {
  type: 'highlight_file' | 'show_diff' | 'show_code' | 'diagram_focus' | 'diagram_update' | 'none';
  filePath?: string;
  lines?: [number, number];
  commitHash?: string;
  diagramNodeId?: string;
  code?: string;
  language?: string;
}

export interface DiagramNode {
  id: string;
  label: string;
  type: 'module' | 'file' | 'area';
  filePath?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: 'dependency' | 'import' | 'call';
}

export interface AnalysisProgress {
  phase: 'reading_commits' | 'parsing_diffs' | 'clustering' | 'generating_narratives' | 'detecting_concerns' | 'generating_architecture' | 'complete';
  progress: number; // 0-1
  message: string;
}
