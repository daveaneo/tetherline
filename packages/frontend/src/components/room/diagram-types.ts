/** Shared render types for the diagram. Lifted out of HermesDiagram so
 *  the deterministic scene harness can construct fixture payloads with
 *  the exact same type the renderer consumes (no `any` at the seam). */

export type Level =
  | 'unknown'
  | 'mentioned'
  | 'heard'
  | 'engaged'
  | 'explained'
  | 'confirmed';

export interface DiagramNode {
  id: string;
  label: string;
  description?: string;
  role?: string;
  weight?: number;
  level?: Level;
  /** Passed a grill / perfect quiz — a separate active-recall QA proof,
   *  independent of `level`. Surfaced as the node's shield badge. */
  grilled?: boolean;
  /** v2 active-recall ratios (live-overlaid; 0/0 = never tested). */
  quizCorrect?: number;
  quizTotal?: number;
  grillStrong?: number;
  grillAsked?: number;
  briefingId?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind?: 'contains' | 'produces' | 'consumes' | 'configures' | 'guards' | 'imports';
  label?: string;
}

export interface DiagramPayload {
  scope: string;
  view: 'logic' | 'file';
  title: string;
  subtitle: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}
