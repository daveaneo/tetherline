export type ConcernSeverity = 'info' | 'warning' | 'critical';
export type ConcernCategory = 'security' | 'breaking_change' | 'missing_tests' | 'performance' | 'pattern' | 'other';

export interface Concern {
  id: string;
  sessionId: string;
  areaId?: string;
  severity: ConcernSeverity;
  category: ConcernCategory;
  title: string;
  description: string;
  affectedFiles: string[];
  commitHashes: string[];
  codeReferences: CodeReference[];
  acknowledged: boolean;
}

export interface CodeReference {
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
}
