export type ExportFormat = 'slides' | 'markdown';

export interface ExportOptions {
  format: ExportFormat;
  areas?: string[]; // filter to specific area IDs
  includeConcerns: boolean;
  includeCodeSnippets: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  filename: string;
  downloadUrl: string;
  generatedAt: string;
}
