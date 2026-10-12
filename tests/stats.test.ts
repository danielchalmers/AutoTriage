/// <reference types="vitest" />
import { RunStatistics, describeModelRun, summarizePlan } from '../src/stats';

describe('RunStatistics', () => {
  let stats: RunStatistics;

  function captureSummaryOutput(print: () => void): string[] {
    const lines: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.join(' '));
    });
    try {
      print();
    } finally {
      logSpy.mockRestore();
    }
    return lines;
  }

  beforeEach(() => {
    stats = new RunStatistics();
  });

  describe('printSummary', () => {
    it('prints only the header for an empty run', () => {
      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toEqual([expect.stringContaining('Run Statistics:')]);
    });

    it('prints the outcome totals and the actions grouped by issue in issue order', () => {
      stats.recordItem({ issueNumber: 3, outcome: 'triaged' });
      stats.recordItem({ issueNumber: 12, outcome: 'triaged' });
      stats.recordItem({ issueNumber: 21, outcome: 'deferred' });
      stats.recordItem({ issueNumber: 22, outcome: 'failed', failureReason: 'other' });
      stats.trackAction({ issueNumber: 12, type: 'comment', details: 'comment' });
      stats.trackAction({ issueNumber: 3, type: 'add_labels', details: 'labels: +bug' });
      stats.trackAction({ issueNumber: 12, type: 'set_state', details: 'state: completed' });

      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toContain('  Total: ✅ 2 triaged ⏸️ 1 deferred ❌ 1 failed');
      const actionLines = lines.filter(line => line.startsWith('  #'));
      expect(actionLines).toEqual(['  #3: labels: +bug', '  #12: comment, state: completed']);
    });

    it('formats run durations', () => {
      stats.setModel('test-model');
      stats.trackModelRun({ startTime: 0, endTime: 400, inputTokens: 1, outputTokens: 1 });
      stats.trackModelRun({ startTime: 0, endTime: 125000, inputTokens: 1, outputTokens: 1 });

      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toContainEqual(expect.stringContaining('Model (test-model)'));
      expect(lines).toContain('    Total: 2m5s • Avg: 1m2s • p95: 2m5s');
    });
  });

  describe('comprehensive scenario', () => {
    it('summarizes cached input with its share of the input', () => {
      stats.setModel('gemini-3.8-flash');
      stats.trackModelRun({
        startTime: 0,
        endTime: 25700,
        inputTokens: 10800,
        cachedInputTokens: 8200,
        outputTokens: 257,
      });

      const lines = captureSummaryOutput(() => stats.printSummary());
      const tokenLine = lines.find(line => line.includes('Tokens:'));
      const cacheLine = lines.find(line => line.includes('Cache:'));

      expect(tokenLine).toBe('    Tokens: 10.8k input • 257 output • reasoning not reported');
      expect(cacheLine).toContain('Cache: 8.2k (75.9%) reused');
    });

    it('shows GitHub API calls', () => {
      stats.incrementGithubApiCalls(15);

      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toContain('  GitHub API: 15 calls');
    });

    it('reports reasoning tokens on the token line when present', () => {
      stats.setModel('test-model');
      stats.trackModelRun({
        startTime: 0,
        endTime: 16000,
        inputTokens: 10000,
        cachedInputTokens: 0,
        outputTokens: 120,
        reasoningTokens: 5400,
      });

      const lines = captureSummaryOutput(() => stats.printSummary());
      const tokenLine = lines.find(line => line.includes('Tokens:'));

      expect(tokenLine).toContain('120 output • 5.4k reasoning');
    });
  });

  describe('describeModelRun', () => {
    it("gives one call's duration and tokens, and says when no reasoning was reported", () => {
      expect(describeModelRun({ startTime: 1000, endTime: 9200, inputTokens: 3050, outputTokens: 85, reasoningTokens: 1890 })).toBe('Answered in 8.2s • 3.0k input • 85 output • 1.9k reasoning');
      expect(describeModelRun({ startTime: 0, endTime: 754000, inputTokens: 900, outputTokens: 40 })).toBe('Answered in 12m34s • 900 input • 40 output • reasoning not reported');
    });
  });

  describe('toJSON run summary', () => {
    it('captures the model, the funnel, the usage and per-item rows', () => {
      stats.setRepository('octo', 'demo');
      stats.setModel('test-model');
      stats.setDiscovered(100);
      stats.setCapReached();
      stats.incrementGithubApiCalls(12);
      stats.setRunConfig({ dryRun: false, extended: true, maxProRuns: 20 });
      stats.setPromptHash('sha256:aaaa');

      // Item 1: triaged with an action, after a first analysis that the item outdated by changing.
      for (const endTime of [2000, 5000]) {
        stats.trackModelRun({ startTime: 0, endTime, inputTokens: 11000, cachedInputTokens: 8000, outputTokens: 120, reasoningTokens: 3000, issueNumber: 1 });
      }
      stats.recordItem({ issueNumber: 1, type: 'pull request', outcome: 'triaged', reanalyzed: true, plan: { kinds: ['add_labels'], labels: ['+bug'] } });
      stats.trackAction({ issueNumber: 1, type: 'add_labels', details: '+bug' });

      // Item 2: the model call failed.
      stats.recordItem({ issueNumber: 2, outcome: 'failed', failureReason: 'capacity' });

      // Item 3: deferred because it changed during analysis.
      // Its title and reason are for the job summary, so the artifact leaves them out.
      stats.trackModelRun({ startTime: 0, endTime: 1000, inputTokens: 9000, outputTokens: 50, issueNumber: 3 });
      stats.recordItem({
        issueNumber: 3,
        type: 'issue',
        title: 'Crash on save',
        outcome: 'deferred',
        changedDuringAnalysis: true,
        plan: { kinds: ['comment'], labels: [] },
        detail: 'It changed while it was being analyzed.',
      });

      const json = JSON.parse(JSON.stringify(stats.toJSON()));

      expect(Object.keys(json)).toEqual(['schemaVersion', 'repo', 'model', 'config', 'promptHash', 'github', 'funnel', 'usage', 'actions', 'items']);
      expect(json).toMatchObject({
        schemaVersion: 5,
        repo: 'octo/demo',
        model: 'test-model',
        config: { dryRun: false, extended: true, maxProRuns: 20 },
        promptHash: 'sha256:aaaa',
        github: { calls: 12 },
        actions: { total: 1, byKind: { add_labels: 1 } },
      });
      expect(json.funnel).toEqual({ discovered: 100, processed: 3, triaged: 1, deferred: 1, failed: 1, capReached: true });
      expect(json.usage).toEqual({
        calls: 3,
        totalMs: 8000,
        avgMs: 2667,
        p95Ms: 5000,
        inputTokens: 31000,
        cachedInputTokens: 16000,
        reasoningTokens: 6000,
        outputTokens: 290,
      });
      expect(json.items).toEqual([
        {
          number: 1,
          type: 'pull request',
          outcome: 'triaged',
          reanalyzed: true,
          plan: { kinds: ['add_labels'], labels: ['+bug'] },
          usage: { ms: 7000, inputTokens: 22000, cachedInputTokens: 16000, reasoningTokens: 6000, outputTokens: 240 },
          operations: ['add_labels'],
        },
        { number: 2, outcome: 'failed', failureReason: 'capacity', usage: null, operations: [] },
        {
          number: 3,
          type: 'issue',
          outcome: 'deferred',
          plan: { kinds: ['comment'], labels: [] },
          usage: { ms: 1000, inputTokens: 9000, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 50 },
          operations: [],
        },
      ]);
    });

    it('serializes an empty run without throwing', () => {
      expect(() => JSON.stringify(stats.toJSON())).not.toThrow();
      const json = stats.toJSON() as any;
      expect(json.items).toEqual([]);
      expect(json.funnel).toEqual({ discovered: 0, processed: 0, triaged: 0, deferred: 0, failed: 0, capReached: false });
      expect(json.usage).toMatchObject({ calls: 0, inputTokens: 0 });
      expect(json.model).toBeNull();
      expect(json.config).toBeNull();
      expect(json.promptHash).toBeNull();
    });

  });

  describe('plan summarization', () => {
    it('sorts unique operation kinds and signs label changes', () => {
      expect(summarizePlan([
        { kind: 'comment' },
        { kind: 'add_labels', labels: ['regression', 'bug'] },
        { kind: 'remove_labels', labels: ['stale'] },
        { kind: 'add_labels', labels: ['bug'] },
      ])).toEqual({
        kinds: ['add_labels', 'comment', 'remove_labels'],
        labels: ['+bug', '+regression', '-stale'],
      });
    });
  });
});
