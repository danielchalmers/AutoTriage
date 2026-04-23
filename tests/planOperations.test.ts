/// <reference types="vitest" />
import { planOperations } from '../src/triage';
import type { AnalysisResult } from '../src/analysis';

describe('planOperations', () => {
  const baseIssue = { number: 1, title: 'Original title', state: 'open' } as any;
  const baseMetadata = { labels: ['bug', 'help wanted'] };

  it('produces label update op when labels differ', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'add_labels', labels: ['feature'], authorization: 'policy allows feature labels' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'feature']);
    const kinds = ops.map(o => o.kind);
    expect(kinds).toContain('add_labels');
  });

  it('filters unknown labels (dropping ghost but may still diff others)', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'add_labels', labels: ['bug', 'ghost'], authorization: 'policy allows bug labels' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug']);
    expect(ops).toEqual([]);
  });

  it('adds comment op when comment present', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: 'Hello there', authorization: 'policy requires a response' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'comment')).toBe(true);
  });

  it('adds title op when title changes', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_title', title: 'Better title', authorization: 'policy allows title edits' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'set_title')).toBe(true);
  });

  it('does not add title op when unchanged', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_title', title: 'Original title', authorization: 'policy allows title edits' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'set_title')).toBe(false);
  });

  it('adds state op when closing with reason', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'completed', authorization: 'policy allows closing completed work' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'set_state')).toBe(true);
  });

  it('no state op when already closed with same reason', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' };
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'completed', authorization: 'policy allows closing completed work' }],
    };
    const ops = planOperations(issue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'set_state')).toBe(false);
  });

  it('reopen op when desired open and currently closed', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' };
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'open', authorization: 'policy allows reopening when info arrives' }],
    };
    const ops = planOperations(issue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'set_state')).toBe(true);
  });

  it('returns no operations for an explicit empty operation plan', () => {
    const analysis: AnalysisResult = { summary: 's', operations: [] };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops).toEqual([]);
  });

  it('skips operations without authorization', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: 'Hello there', authorization: '' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops).toEqual([]);
  });

  it('skips malformed operations instead of inferring work', () => {
    const analysis = {
      summary: 's',
      operations: [null, { kind: 'labels', labels: ['feature'], authorization: 'old shape' }],
    } as unknown as AnalysisResult;
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['feature']);
    expect(ops).toEqual([]);
  });
});
