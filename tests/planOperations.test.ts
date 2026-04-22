/// <reference types="vitest" />
import { planOperations } from '../src/triage';
import type { OperationPlanResult } from '../src/analysis';

describe('planOperations', () => {
  const baseIssue = { number: 1, title: 'Original title', state: 'open' } as any;
  const baseMetadata = { labels: ['bug', 'help wanted'] };

  it('treats an empty operation list as no work', () => {
    const analysis: OperationPlanResult = { summary: 's', operations: [] };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'feature']);
    expect(ops).toEqual([]);
  });

  it('converts add_labels operations into label updates', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'add_labels', labels: ['feature'], authorization: 'policy: classify features' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'help wanted', 'feature']);
    const labelOp: any = ops.find(o => o.kind === 'labels');
    expect(labelOp).toBeDefined();
    expect(labelOp.toAdd).toEqual(['feature']);
    expect(labelOp.toRemove).toEqual([]);
  });

  it('converts remove_labels operations into label updates', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'remove_labels', labels: ['help wanted'], authorization: 'policy: stale cleanup' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'help wanted']);
    const labelOp: any = ops.find(o => o.kind === 'labels');
    expect(labelOp).toBeDefined();
    expect(labelOp.toAdd).toEqual([]);
    expect(labelOp.toRemove).toEqual(['help wanted']);
  });

  it('filters unknown labels from label operations and skips no-op updates', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'add_labels', labels: ['bug', 'ghost'], authorization: 'policy: bug reports' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, ['bug']);
    expect(ops.find(o => o.kind === 'labels')).toBeUndefined();
  });

  it('drops operations without meaningful authorization', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: 'Hello there', authorization: '   ' }],
    } as OperationPlanResult;
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops).toEqual([]);
  });

  it('adds comment ops from explicit comment operations without leaking authorization', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'comment', body: 'Hello there', authorization: 'policy: ask for details' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, [], 'private thoughts');
    const commentOp = ops.find(o => o.kind === 'comment');
    expect(commentOp).toBeDefined();
    expect(commentOp?.toJSON().body).toContain('Hello there');
    expect(commentOp?.toJSON().body).not.toContain('policy: ask for details');
  });

  it('adds title ops from set_title operations when changed', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'set_title', title: 'Better title', authorization: 'policy: improve unclear titles' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'title')).toBe(true);
  });

  it('does not add title ops when the title is unchanged', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'set_title', title: 'Original title', authorization: 'policy: improve unclear titles' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'title')).toBe(false);
  });

  it('adds state ops when closing with a reason', () => {
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'completed', authorization: 'policy: close completed work' }],
    };
    const ops = planOperations(baseIssue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'state')).toBe(true);
  });

  it('does not add state ops when already closed with the same reason', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' };
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'completed', authorization: 'policy: close completed work' }],
    };
    const ops = planOperations(issue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'state')).toBe(false);
  });

  it('reopens when set_state requests open and the issue is closed', () => {
    const issue = { ...baseIssue, state: 'closed', state_reason: 'completed' };
    const analysis: OperationPlanResult = {
      summary: 's',
      operations: [{ kind: 'set_state', state: 'open', authorization: 'policy: reopen with new info' }],
    };
    const ops = planOperations(issue, analysis, baseMetadata, []);
    expect(ops.some(o => o.kind === 'state')).toBe(true);
  });
});
