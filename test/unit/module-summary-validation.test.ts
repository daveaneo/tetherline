/**
 * Cached module summaries render verbatim on diagram nodes and feed
 * answer prompts — a malformed one poisons both. Live bug: the colab
 * module cached as the truncated fragment "After generating your
 * notebook in PersonalForge:" and the AI later narrated about "the
 * truncated notebook file".
 */
import { describe, it, expect } from 'vitest';
import { isValidModuleSummary } from '../../packages/backend/src/cache/warmer.js';

describe('isValidModuleSummary', () => {
  it('rejects the literal live-bug fragment (trailing colon, no sentence)', () => {
    expect(isValidModuleSummary('After generating your notebook in PersonalForge:')).toBe(false);
  });

  it('rejects too-short summaries', () => {
    expect(isValidModuleSummary('Handles auth.')).toBe(false);
    expect(isValidModuleSummary('')).toBe(false);
    expect(isValidModuleSummary('   ')).toBe(false);
  });

  it('rejects dangling clauses and headers', () => {
    expect(isValidModuleSummary('This module is responsible for the following tasks;')).toBe(false);
    expect(isValidModuleSummary('The core pipeline handles ingestion, dedupe, and —')).toBe(false);
    expect(isValidModuleSummary('A module that processes audio and then converts it into')).toBe(false);
  });

  it('accepts complete prose summaries', () => {
    expect(isValidModuleSummary(
      'The core module is the data-pipeline and hardware-intelligence backbone of PersonalForge.',
    )).toBe(true);
    expect(isValidModuleSummary(
      'Generates Colab-ready notebooks so users can fine-tune models without local GPUs. It wraps the training loop.',
    )).toBe(true);
    expect(isValidModuleSummary(
      'Utility helpers shared across packages (types, constants, parsing).',
    )).toBe(true);
  });
});
