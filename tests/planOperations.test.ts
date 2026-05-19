/// <reference types="vitest" />
import { planOperations } from '../src/triage';
import type { AnalysisResult } from '../src/analysis';

describe('planOperations', () => {
  const baseIssue = { number: 1, title: 'Original title', state: 'open' } as const;
  const baseMetadata = { labels: ['bug', 'help wanted'] };

  it('produces plain label update data when labels differ', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'add_labels', labels: ['feature'], authorization: 'policy allows feature labels' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, ['bug', 'feature'])).toEqual([
      { kind: 'add_labels', labels: ['feature'], authorization: 'policy allows feature labels' },
    ]);
  });

  it('filters unknown labels', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'add_labels', labels: ['bug', 'ghost'], authorization: 'policy allows bug labels' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, ['bug'])).toEqual([]);
  });

  it('drops duplicate and no-op label changes while preserving order', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [
        { kind: 'add_labels', labels: ['feature', 'feature', 'bug'], authorization: 'policy allows feature labels' },
        { kind: 'remove_labels', labels: ['help wanted', 'help wanted', 'ghost'], authorization: 'policy allows cleanup' },
        { kind: 'add_labels', labels: ['help wanted'], authorization: 'policy allows restore' },
      ],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, ['bug', 'feature', 'help wanted'])).toEqual([
      { kind: 'add_labels', labels: ['feature'], authorization: 'policy allows feature labels' },
      { kind: 'remove_labels', labels: ['help wanted'], authorization: 'policy allows cleanup' },
      { kind: 'add_labels', labels: ['help wanted'], authorization: 'policy allows restore' },
    ]);
  });

  it('adds comment data when comment present', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: 'Hello there', authorization: 'policy requires a response' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, [], 'internal reasoning')).toEqual([
      {
        kind: 'comment',
        body: 'Hello there',
        authorization: 'policy requires a response',
        thoughts: 'internal reasoning',
      },
    ]);
  });

  it('ignores empty comments', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: '   ', authorization: 'policy requires a response' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, [])).toEqual([]);
  });

  it('adds title data when title changes', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_title', title: 'Better title', authorization: 'policy allows title edits' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, [])).toEqual([
      { kind: 'set_title', title: 'Better title', authorization: 'policy allows title edits' },
    ]);
  });

  it('does not add title data when unchanged', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_title', title: 'Original title', authorization: 'policy allows title edits' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, [])).toEqual([]);
  });

  it('adds state data when closing with reason', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'completed', authorization: 'policy allows closing completed work' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, [])).toEqual([
      { kind: 'set_state', state: 'completed', authorization: 'policy allows closing completed work' },
    ]);
  });

  it('adds no state data when already closed with same reason', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' } as const;
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'completed', authorization: 'policy allows closing completed work' }],
    };

    expect(planOperations(issue, analysis, baseMetadata, [])).toEqual([]);
  });

  it('adds reopen data when desired open and currently closed', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' } as const;
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'open', authorization: 'policy allows reopening when info arrives' }],
    };

    expect(planOperations(issue, analysis, baseMetadata, [])).toEqual([
      { kind: 'set_state', state: 'open', authorization: 'policy allows reopening when info arrives' },
    ]);
  });

  it('returns no operations for an explicit empty operation plan', () => {
    const analysis: AnalysisResult = { summary: 's', operations: [] };

    expect(planOperations(baseIssue, analysis, baseMetadata, [])).toEqual([]);
  });

  it('skips operations without authorization', () => {
    const analysis: AnalysisResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: 'Hello there', authorization: '' }],
    };

    expect(planOperations(baseIssue, analysis, baseMetadata, [])).toEqual([]);
  });

  it('skips malformed operations instead of inferring work', () => {
    const analysis = {
      summary: 's',
      operations: [null, { kind: 'labels', labels: ['feature'], authorization: 'old shape' }],
    } as unknown as AnalysisResult;

    expect(planOperations(baseIssue, analysis, baseMetadata, ['feature'])).toEqual([]);
  });
});
