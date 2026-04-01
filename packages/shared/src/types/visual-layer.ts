export type VisualLayer = 1 | 2 | 3 | 4 | 5;

export const LAYER_NAMES: Record<VisualLayer, string> = {
  1: 'Overview',
  2: 'Concept',
  3: 'Architecture',
  4: 'Component',
  5: 'Code',
};

export interface ConceptualStep {
  icon: string;
  title: string;
  description: string;
}
