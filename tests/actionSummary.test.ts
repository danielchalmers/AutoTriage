import { describe, expect, it } from 'vitest';
import { formatActionSummary, ActionSummary } from '../src/summary';
import { planOperations } from '../src/triage';
import type { AnalysisResult } from '../src/analysis';

describe('formatActionSummary', () => {
  it('formats label additions correctly', () => {
    const baseIssue = { number: 42, title: 'Test', state: 'open', labels: [] } as any;
    const baseMetadata = { labels: [] };
    const analysis: AnalysisResult = { summary: 's', labels: ['bug', 'enhancement'] };
    const operations = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'enhancement']);
    
    const summaries: ActionSummary[] = [{ issueNumber: 42, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('#42: labels: +bug, +enhancement');
  });

  it('formats label removals correctly', () => {
    const baseIssue = { number: 10, title: 'Test', state: 'open', labels: ['old-label'] } as any;
    const baseMetadata = { labels: ['old-label'] };
    const analysis: AnalysisResult = { summary: 's', labels: [] };
    const operations = planOperations(baseIssue, analysis, baseMetadata, ['old-label']);
    
    const summaries: ActionSummary[] = [{ issueNumber: 10, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('#10: labels: -old-label');
  });

  it('formats mixed label operations correctly', () => {
    const baseIssue = { number: 5, title: 'Test', state: 'open', labels: ['old'] } as any;
    const baseMetadata = { labels: ['old'] };
    const analysis: AnalysisResult = { summary: 's', labels: ['bug', 'new'] };
    const operations = planOperations(baseIssue, analysis, baseMetadata, ['bug', 'new', 'old']);
    
    const summaries: ActionSummary[] = [{ issueNumber: 5, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('labels:');
    expect(lines[0]).toContain('+bug');
    expect(lines[0]).toContain('+new');
    expect(lines[0]).toContain('-old');
  });

  it('formats comment operations correctly', () => {
    const baseIssue = { number: 7, title: 'Test', state: 'open' } as any;
    const baseMetadata = {};
    const analysis: AnalysisResult = { summary: 's', comment: 'Hello there!' };
    const operations = planOperations(baseIssue, analysis, baseMetadata, []);
    
    const summaries: ActionSummary[] = [{ issueNumber: 7, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('#7: comment');
  });

  it('formats title change operations correctly', () => {
    const baseIssue = { number: 15, title: 'Old title', state: 'open' } as any;
    const baseMetadata = {};
    const analysis: AnalysisResult = { summary: 's', newTitle: 'New title' };
    const operations = planOperations(baseIssue, analysis, baseMetadata, []);
    
    const summaries: ActionSummary[] = [{ issueNumber: 15, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('#15: title change');
  });

  it('formats state change operations correctly', () => {
    const baseIssue = { number: 99, title: 'Test', state: 'open' } as any;
    const baseMetadata = {};
    const analysis: AnalysisResult = { summary: 's', state: 'completed' };
    const operations = planOperations(baseIssue, analysis, baseMetadata, []);
    
    const summaries: ActionSummary[] = [{ issueNumber: 99, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('#99: state: completed');
  });

  it('formats multiple operations for a single issue correctly', () => {
    const baseIssue = { number: 20, title: 'Old', state: 'open', labels: [] } as any;
    const baseMetadata = { labels: [] };
    const analysis: AnalysisResult = {
      summary: 's',
      labels: ['bug'],
      comment: 'Test comment',
      newTitle: 'New title',
    };
    const operations = planOperations(baseIssue, analysis, baseMetadata, ['bug']);
    
    const summaries: ActionSummary[] = [{ issueNumber: 20, operations }];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('#20:');
    expect(lines[0]).toContain('title change');
    expect(lines[0]).toContain('labels: +bug');
    expect(lines[0]).toContain('comment');
  });

  it('formats multiple issues correctly', () => {
    const issue1 = { number: 1, title: 'Issue 1', state: 'open', labels: [] } as any;
    const issue2 = { number: 2, title: 'Issue 2', state: 'open', labels: [] } as any;
    const baseMetadata = { labels: [] };
    
    const analysis1: AnalysisResult = { summary: 's1', labels: ['bug'] };
    const operations1 = planOperations(issue1, analysis1, baseMetadata, ['bug']);
    
    const analysis2: AnalysisResult = { summary: 's2', comment: 'Hi' };
    const operations2 = planOperations(issue2, analysis2, baseMetadata, []);
    
    const summaries: ActionSummary[] = [
      { issueNumber: 1, operations: operations1 },
      { issueNumber: 2, operations: operations2 },
    ];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('#1: labels: +bug');
    expect(lines[1]).toBe('#2: comment');
  });

  it('returns empty array when no operations were performed', () => {
    const summaries: ActionSummary[] = [];
    const lines = formatActionSummary(summaries);
    
    expect(lines).toHaveLength(0);
  });

  it('skips issues with no operations', () => {
    const baseIssue = { number: 50, title: 'Test', state: 'open', labels: ['bug'] } as any;
    const baseMetadata = { labels: ['bug'] };
    const analysis: AnalysisResult = { summary: 's', labels: ['bug'] }; // No change
    const operations = planOperations(baseIssue, analysis, baseMetadata, ['bug']);
    
    const summaries: ActionSummary[] = [{ issueNumber: 50, operations }];
    const lines = formatActionSummary(summaries);
    
    // No operations should be generated since labels are the same
    expect(lines).toHaveLength(0);
  });
});
