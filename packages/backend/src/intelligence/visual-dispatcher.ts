/**
 * Shared visual dispatcher (B0).
 *
 * Skills never own visuals — they call `dispatchVisual(input)` with a
 * free-form target. This module deterministically (a) resolves the
 * target to a node id and (b) classifies the navigational relationship
 * between the current view and the target, which drives the diagram
 * transition. No LLM here: routing is pure and cheap. Only the
 * GENERATE outcome (target resolves to no node anywhere) implies a
 * downstream generative call, made by the caller, not here.
 *
 * Resolution order is most-specific-first and fully deterministic
 * (stable sort) so the same input always yields the same node — this
 * replaces the ad-hoc substring matching that previously lived inside
 * HermesDiagram and could double-drill ("core" → module/core, then
 * file/core/loader.py).
 */
import type { DispatchInput, DispatchResult, VisualTransition } from '@tetherline/shared';

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/** Last path segment — a node's own identity, not its ancestors'. */
function leafOf(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1];
}

/** Deterministically resolve a free-form target against a node set. */
function resolveInSet(
  target: string,
  ids: string[],
  labels: Record<string, string> | undefined,
): string | undefined {
  const t = norm(target);
  if (!t) return undefined;

  // 1. exact id
  if (ids.includes(target)) return target;
  // 2. module/<target> convention
  const moduleId = `module/${t}`;
  if (ids.includes(moduleId)) return moduleId;
  // 3. exact label match (case-insensitive)
  if (labels) {
    const labelHits = ids
      .filter(id => labels[id] !== undefined && norm(labels[id]) === t)
      .sort();
    if (labelHits.length > 0) return labelHits[0];
  }
  // 4. exact LEAF match. The leaf is the node's own identity; an
  //    interior path segment belongs to an ANCESTOR, not this node —
  //    matching it caused the historical double-drill ("core" →
  //    file/core/loader.py). Only leaf/label are valid identities.
  const leafExact = ids.filter(id => norm(leafOf(id)) === t).sort();
  if (leafExact.length > 0) return leafExact[0];
  // 5. substring match on LEAF or label only (never interior path
  //    segments). Prefer the SHORTEST id (most specific scope),
  //    tie-broken lexicographically for determinism.
  const subHits = ids
    .filter(id => {
      const leafHit = norm(leafOf(id)).includes(t);
      const labelHit = labels?.[id] !== undefined && norm(labels[id]).includes(t);
      return leafHit || labelHit;
    })
    .sort((a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0));
  return subHits[0];
}

/** Closest known id to an unresolved target, for graceful "did you mean". */
function closest(target: string, ids: string[]): string | undefined {
  const t = norm(target);
  if (!t || ids.length === 0) return undefined;
  const scored = ids
    .map(id => {
      const n = norm(id);
      let score = 0;
      for (const part of t.split(/[\s/_-]+/)) {
        if (part && n.includes(part)) score += part.length;
      }
      return { id, score };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
  return scored[0]?.id;
}

export function dispatchVisual(input: DispatchInput): DispatchResult {
  const {
    target,
    currentScope,
    knownNodeIds,
    nodeLabels,
    navigatorAncestors = [],
    globalNodeIds = [],
    globalNodeLabels,
  } = input;

  const inCurrent = resolveInSet(target, knownNodeIds, nodeLabels);

  if (inCurrent) {
    let transition: VisualTransition;
    let reason: string;
    if (currentScope !== null && inCurrent === currentScope) {
      transition = 'IN_PLACE';
      reason = 'target resolves to the current scope';
    } else if (navigatorAncestors.includes(inCurrent)) {
      transition = 'ASCEND';
      reason = 'target is an ancestor of the current scope';
    } else {
      transition = 'DESCEND';
      reason = 'target is a node within the current view';
    }
    return { transition, targetNodeId: inCurrent, reason };
  }

  // Not in the current view — is it elsewhere in the repo (LATERAL)
  // or an ancestor we navigated past, or nowhere (GENERATE)?
  const inGlobal = resolveInSet(target, globalNodeIds, globalNodeLabels);
  if (inGlobal) {
    if (navigatorAncestors.includes(inGlobal)) {
      return {
        transition: 'ASCEND',
        targetNodeId: inGlobal,
        reason: 'target is an ancestor not in the current node set',
      };
    }
    return {
      transition: 'LATERAL',
      targetNodeId: inGlobal,
      reason: 'target resolves to an unrelated branch elsewhere',
    };
  }

  // Resolves nowhere → GENERATE. Carry a suggestion so callers that
  // must NOT generate (navigate) can fail gracefully instead.
  return {
    transition: 'GENERATE',
    reason: 'target has no node anywhere in the diagram model',
    suggestion: closest(target, knownNodeIds.length ? knownNodeIds : globalNodeIds),
  };
}
