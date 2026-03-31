export interface TourItem {
  id: string;
  parentId?: string;
  type: 'project' | 'architecture' | 'component' | 'file' | 'code';
  name: string;
  areaId?: string;
  nodeId?: string;
  filePath?: string;
  covered: boolean;
  skipped: boolean;
}

export interface DeviationEntry {
  returnToIndex: number;
  returnToPhase: string;
  returnToAreaIndex?: number;
  returnToSegmentIndex?: number;
  coveredDuringDeviation: Set<string>;
  checkedIn: boolean;
}

export class TourPlan {
  items: TourItem[] = [];
  currentIndex: number = 0;
  private coveredIds = new Set<string>();
  private deviationStack: DeviationEntry[] = [];

  static fromAreas(areas: Array<{ id: string; name: string; affectedFiles: string[] }>): TourPlan {
    const plan = new TourPlan();

    for (const area of areas) {
      // Component-level item
      plan.items.push({
        id: `component-${area.id}`,
        type: 'component',
        name: area.name,
        areaId: area.id,
        covered: false,
        skipped: false,
      });

      // File-level items
      for (const file of area.affectedFiles.slice(0, 10)) {
        plan.items.push({
          id: `file-${area.id}-${file}`,
          parentId: `component-${area.id}`,
          type: 'file',
          name: file,
          areaId: area.id,
          filePath: file,
          covered: false,
          skipped: false,
        });
      }
    }

    return plan;
  }

  markCovered(itemId: string): void {
    this.coveredIds.add(itemId);
    const item = this.items.find(i => i.id === itemId);
    if (item) item.covered = true;

    // If in a deviation, track what's been seen
    const currentDeviation = this.getCurrentDeviation();
    if (currentDeviation) {
      currentDeviation.coveredDuringDeviation.add(itemId);
    }
  }

  markAreaCovered(areaId: string): void {
    for (const item of this.items) {
      if (item.areaId === areaId) {
        this.markCovered(item.id);
      }
    }
  }

  isCovered(itemId: string): boolean {
    return this.coveredIds.has(itemId);
  }

  // Get the next uncovered item from the current position
  getNextUncovered(): TourItem | null {
    for (let i = this.currentIndex; i < this.items.length; i++) {
      const item = this.items[i];
      if (!item.covered && !item.skipped) {
        this.currentIndex = i;
        return item;
      }
    }
    return null;
  }

  // Check if an upcoming item was already covered (e.g., during deviation)
  shouldSkip(itemId: string): boolean {
    return this.coveredIds.has(itemId);
  }

  // Get items that were skipped due to deviation coverage
  getSkippedByDeviation(): string[] {
    const currentDeviation = this.getCurrentDeviation();
    if (!currentDeviation) return [];

    const upcoming = this.items.slice(this.currentIndex);
    return upcoming
      .filter(item => currentDeviation.coveredDuringDeviation.has(item.id))
      .map(item => item.name);
  }

  // Deviation management
  pushDeviation(phase: string, areaIndex?: number, segmentIndex?: number): void {
    this.deviationStack.push({
      returnToIndex: this.currentIndex,
      returnToPhase: phase,
      returnToAreaIndex: areaIndex,
      returnToSegmentIndex: segmentIndex,
      coveredDuringDeviation: new Set(),
      checkedIn: false,
    });
  }

  popDeviation(): DeviationEntry | undefined {
    return this.deviationStack.pop();
  }

  getCurrentDeviation(): DeviationEntry | undefined {
    return this.deviationStack[this.deviationStack.length - 1];
  }

  isInDeviation(): boolean {
    return this.deviationStack.length > 0;
  }

  markDeviationCheckedIn(): void {
    const current = this.getCurrentDeviation();
    if (current) current.checkedIn = true;
  }

  hasCheckedIn(): boolean {
    const current = this.getCurrentDeviation();
    return current?.checkedIn ?? false;
  }

  // Get a resume message
  getResumeMessage(): string {
    const deviation = this.getCurrentDeviation();
    if (!deviation) return "Let's continue.";

    const skipped = this.getSkippedByDeviation();
    const returnItem = this.items[deviation.returnToIndex];

    if (skipped.length > 0) {
      return `Let's pick back up. We were looking at ${returnItem?.name ?? 'the tour'}. I'll skip ${skipped.join(', ')} since we already covered ${skipped.length === 1 ? 'that' : 'those'}.`;
    }

    return `Let's pick back up where we left off — ${returnItem?.name ?? 'the tour'}.`;
  }

  // Completion stats
  getProgress(): { total: number; covered: number; percentage: number } {
    const total = this.items.length;
    const covered = this.items.filter(i => i.covered || i.skipped).length;
    return { total, covered, percentage: total > 0 ? Math.round((covered / total) * 100) : 0 };
  }
}
