import { describe, it, expect } from 'vitest';
import {
  authorizeTask,
  rejectionToShelfArtifact,
  outcomeToShelfArtifact,
  DEFAULT_CEILING,
  type Capability,
} from '../../packages/backend/src/skills/task-authz.js';

const NOW = () => new Date('2026-05-15T11:00:00.000Z');
const CAPS: Capability[] = ['read_only', 'draft', 'write'];

describe('task permission ceiling — ENFORCED, never downgraded', () => {
  it('default ceiling is read_only (safe by default)', () => {
    expect(DEFAULT_CEILING).toBe('read_only');
  });

  // Exhaustive ceiling × request matrix — the safety-critical table.
  const ALLOWED: Record<Capability, Capability[]> = {
    read_only: ['read_only'],
    draft: ['read_only', 'draft'],
    write: ['read_only', 'draft', 'write'],
  };
  for (const ceiling of CAPS) {
    for (const requested of CAPS) {
      const shouldAllow = ALLOWED[ceiling].includes(requested);
      it(`ceiling=${ceiling} request=${requested} → ${shouldAllow ? 'ALLOW' : 'REJECT'}`, () => {
        const r = authorizeTask(requested, ceiling);
        expect(r.allowed).toBe(shouldAllow);
        if (!r.allowed) {
          // Rejected — and it is a REJECTION, not a silent downgrade
          // to a lower capability.
          expect(r).not.toHaveProperty('capability');
          expect(r.requested).toBe(requested);
          expect(r.ceiling).toBe(ceiling);
        } else {
          expect(r.capability).toBe(requested); // exactly what was asked, not less
        }
      });
    }
  }

  it('read_only ceiling REJECTS write (the canonical danger case)', () => {
    const r = authorizeTask('write', 'read_only');
    expect(r.allowed).toBe(false);
  });
});

describe('rejections + outcomes land on the shelf, never interrupt', () => {
  it('a rejection becomes a blocked tasks-row (audit, not a spoken line)', () => {
    const r = authorizeTask('write', 'read_only');
    if (r.allowed) throw new Error('expected reject');
    const art = rejectionToShelfArtifact(r, 'b1', NOW);
    expect(art.section).toBe('tasks');
    expect(art.state).toBe('blocked');
    expect(art.detail).toContain('ceiling');
  });

  it('read_only success → a report row', () => {
    const a = outcomeToShelfArtifact({ kind: 'report', text: 'found 3 TODOs' }, 'Audit', 't1', NOW);
    expect(a).toMatchObject({ section: 'tasks', summary: 'Audit', state: 'done' });
  });

  it('write/draft success → a DIFF row scoped to a sandbox branch (never applied to working tree)', () => {
    const a = outcomeToShelfArtifact(
      { kind: 'diff', patch: 'diff --git a b', branch: 'task/auth-fix' },
      'Auth fix',
      't2',
      NOW,
    );
    expect(a.state).toBe('branch:task/auth-fix');
    expect(a.summary).toContain('review & apply');
  });

  it('failure ALSO lands on the shelf (error state) — must not preempt voice', () => {
    const a = outcomeToShelfArtifact({ kind: 'error', message: 'agent timed out' }, 'Refactor', 't3', NOW);
    expect(a.state).toBe('error');
    expect(a.section).toBe('tasks');
    expect(a.detail).toBe('agent timed out');
  });
});
