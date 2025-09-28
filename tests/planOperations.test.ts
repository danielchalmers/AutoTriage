/// <reference types="vitest" />
import { planOperations } from '../src/triage';
import type { TriageAssessment } from '../src/analysis';

describe('planOperations', () => {
  const baseIssue = { number: 1, title: 'Original title', state: 'open' } as any;
  const baseMetadata = { labels: ['bug', 'help wanted'] };

  it('produces label update op when labels differ', () => {
    const analysis: TriageAssessment = { summary: 's', labels: ['bug', 'feature'] };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'feature']);
    const kinds = ops.map(o => o.kind);
    expect(kinds).toContain('labels');
  });

  it('filters unknown labels (dropping ghost but may still diff others)', () => {
    const analysis: TriageAssessment = { summary: 's', labels: ['bug', 'ghost'] };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug']);
    const labelOp: any = ops.find(o => o.kind === 'labels');
    expect(labelOp).toBeDefined();
    // Ensure ghost was not scheduled for addition
    expect(labelOp.toAdd).not.toContain('ghost');
  });

  it('adds comment op when comment present', () => {
    const analysis: TriageAssessment = { summary: 's', comment: 'Hello there' };
    const ops = planOperations(baseIssue, analysis, baseMetadata, [], { thoughtSummaries: ['Thought A'] });
    const comment = ops.find(o => o.kind === 'comment') as any;
    expect(comment).toBeTruthy();
    expect(comment.body).toContain('Thought A');
  });

  it('adds title op when newTitle changes', () => {
    const analysis: TriageAssessment = { summary: 's', newTitle: 'Better title' };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'title')).toBe(true);
  });

  it('does not add title op when unchanged', () => {
    const analysis: TriageAssessment = { summary: 's', newTitle: 'Original title' };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'title')).toBe(false);
  });

  it('adds state op when closing with reason', () => {
    const analysis: TriageAssessment = { summary: 's', state: 'completed' };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'state')).toBe(true);
  });

  it('no state op when already closed with same reason', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' };
    const analysis: TriageAssessment = { summary: 's', state: 'completed' };
    const ops = planOperations(issue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'state')).toBe(false);
  });

  it('reopen op when desired open and currently closed', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' };
    const analysis: TriageAssessment = { summary: 's', state: 'open' };
    const ops = planOperations(issue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'state')).toBe(true);
  });
});
