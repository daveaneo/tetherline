import { describe, it, expect } from 'vitest';
import { resolveNavOp, CANONICAL_NAV_PHRASES } from '../../packages/backend/src/session/navigator-vocab.js';

describe('resolveNavOp — canonical phrase coverage', () => {
  it.each(CANONICAL_NAV_PHRASES)(
    'routes "$phrase" → $expected',
    ({ phrase, expected, target }) => {
      const op = resolveNavOp(phrase);
      expect(op.kind).toBe(expected);
      if (op.kind === 'push_named' && target) {
        expect(op.target).toBe(target);
      }
    },
  );

  it('returns "none" for unmatched prose', () => {
    expect(resolveNavOp('how do idempotency keys get generated').kind).toBe('none');
    expect(resolveNavOp('the weather in london').kind).toBe('none');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(resolveNavOp('   Go Back  ').kind).toBe('pop');
    expect(resolveNavOp('BACK TO THE OVERVIEW').kind).toBe('pop_to_project');
  });
});

describe('Navigator stack', () => {
  it('push/peek/pop round-trip', async () => {
    const { Navigator } = await import('../../packages/backend/src/session/navigator.js');
    const nav = new Navigator();
    nav.push({ briefingId: 'project', layer: 'project', title: 'Root', reason: 'session_start' });
    nav.push({ briefingId: 'arch/root', layer: 'architecture', title: 'Architecture', reason: 'user_asked' });
    expect(nav.depth).toBe(2);
    expect(nav.peek()?.briefingId).toBe('arch/root');
    expect(nav.pop()?.briefingId).toBe('arch/root');
    expect(nav.depth).toBe(1);
    expect(nav.peek()?.briefingId).toBe('project');
  });

  it('popTo walks up until predicate matches', async () => {
    const { Navigator } = await import('../../packages/backend/src/session/navigator.js');
    const nav = new Navigator();
    nav.push({ briefingId: 'project', layer: 'project', title: 'P', reason: 'session_start' });
    nav.push({ briefingId: 'arch/root', layer: 'architecture', title: 'A', reason: 'user_asked' });
    nav.push({ briefingId: 'module/payments', layer: 'module', title: 'payments', reason: 'user_asked' });
    nav.push({ briefingId: 'concept/idempotency', layer: 'concept', title: 'idempotency', reason: 'user_asked' });

    const removed = nav.popToProject();
    expect(removed.map(r => r.briefingId)).toEqual([
      'concept/idempotency', 'module/payments', 'arch/root',
    ]);
    expect(nav.depth).toBe(1);
    expect(nav.peek()?.briefingId).toBe('project');
  });

  it('breadcrumb walks leaf-first, includes all titles', async () => {
    const { Navigator } = await import('../../packages/backend/src/session/navigator.js');
    const nav = new Navigator();
    nav.push({ briefingId: 'project', layer: 'project', title: 'tetherline', reason: 'session_start' });
    nav.push({ briefingId: 'arch/root', layer: 'architecture', title: 'Architecture', reason: 'user_asked' });
    nav.push({ briefingId: 'module/payments', layer: 'module', title: 'payments', reason: 'user_asked' });
    const crumb = nav.breadcrumb();
    expect(crumb).toMatch(/payments/);
    expect(crumb).toMatch(/Architecture/);
    expect(crumb).toMatch(/tetherline/);
  });

  it('checkPush enforces soft depth cap', async () => {
    const { Navigator } = await import('../../packages/backend/src/session/navigator.js');
    const nav = new Navigator();
    for (let i = 0; i < nav.softDepthCap; i++) {
      nav.push({ briefingId: `frame-${i}`, layer: 'module', title: `F${i}`, reason: 'user_asked' });
    }
    const check = nav.checkPush('frame-next');
    expect(check.allowed).toBe(true);
    expect(check.hint).toMatch(/levels deep/);
  });

  it('checkPush rejects duplicate pushes of the same briefing', async () => {
    const { Navigator } = await import('../../packages/backend/src/session/navigator.js');
    const nav = new Navigator();
    nav.push({ briefingId: 'module/a', layer: 'module', title: 'a', reason: 'user_asked' });
    const check = nav.checkPush('module/a');
    expect(check.allowed).toBe(false);
  });
});
