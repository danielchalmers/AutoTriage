/// <reference types="vitest" />
import { RunStatistics } from '../src/stats';

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

  describe('tracking counts', () => {
    it('tracks failed count', () => {
      stats.incrementFailed();
      expect(stats.getFailed()).toBe(1);

      expect(() => stats.printSummary()).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('handles empty statistics', () => {
      expect(() => stats.printSummary()).not.toThrow();
    });
  });

  describe('comprehensive scenario', () => {
    it('summarizes cache usage with hit rate and cached percentage', () => {
      stats.setModelNames('gemini-3.1-flash-lite', 'gemini-3-flash-preview');
      stats.trackCacheCreate({
        mode: 'pro',
        model: 'gemini-3-flash-preview',
        name: 'cache/pro',
        tokenCount: 8200,
      });
      stats.trackProRun({
        startTime: 0,
        endTime: 25700,
        inputTokens: 10800,
        cachedInputTokens: 8200,
        outputTokens: 257,
        cacheName: 'cache/pro',
      });

      const lines = captureSummaryOutput(() => stats.printSummary());
      const tokenLine = lines.find(line => line.includes('Tokens:'));
      const cacheLine = lines.find(line => line.includes('Cache:'));

      expect(tokenLine).toContain('Tokens: 10.8k input • 257 output');
      expect(cacheLine).toContain('Cache: 8.2k created • 8.2k (75.9%) reused');
    });

    it('shows GitHub API calls with retries', () => {
      stats.incrementGithubApiCalls(15);

      const lines = captureSummaryOutput(() => stats.printSummary());
      const apiLine = lines.find(line => line.includes('GitHub API:'));

      expect(apiLine).toContain('GitHub API: 15 calls • 0 retries');
    });

    it('reports thinking tokens on the token line when present', () => {
      stats.setModelNames('', 'pro-model');
      stats.trackProRun({
        startTime: 0,
        endTime: 16000,
        inputTokens: 10000,
        cachedInputTokens: 0,
        outputTokens: 120,
        thoughtsTokens: 5400,
      });

      const lines = captureSummaryOutput(() => stats.printSummary());
      const tokenLine = lines.find(line => line.includes('Tokens:'));

      expect(tokenLine).toContain('120 output • 5.4k thinking');
    });
  });

  describe('toJSON run summary', () => {
    it('captures the funnel, per-pass thinking tokens, and per-item rows', () => {
      stats.setRepository('octo', 'demo');
      stats.setModelNames('fast-model', 'pro-model');
      stats.setDiscovered(100);
      stats.setCapReached('fast');
      stats.incrementGithubApiCalls(12);

      // Item 1: fast pass gates it out (no escalation).
      stats.trackFastRun({
        startTime: 0,
        endTime: 1000,
        inputTokens: 9000,
        cachedInputTokens: 6000,
        outputTokens: 5,
        thoughtsTokens: 4000,
        issueNumber: 1,
        cacheName: 'cache/fast',
      });
      stats.recordItem({ issueNumber: 1, type: 'issue', outcome: 'skipped', skipReason: 'noop-fast', escalatedToPro: false });
      stats.incrementSkipped();

      // Item 2: escalates to pro, triaged, performs an action.
      stats.trackFastRun({
        startTime: 0,
        endTime: 2000,
        inputTokens: 9000,
        cachedInputTokens: 6000,
        outputTokens: 8,
        thoughtsTokens: 3000,
        issueNumber: 2,
      });
      stats.trackProRun({
        startTime: 0,
        endTime: 5000,
        inputTokens: 11000,
        cachedInputTokens: 8000,
        outputTokens: 120,
        thoughtsTokens: 6000,
        issueNumber: 2,
        cacheName: 'cache/pro',
      });
      stats.recordItem({ issueNumber: 2, type: 'pull request', outcome: 'triaged', escalatedToPro: true });
      stats.trackAction({ issueNumber: 2, type: 'add_labels', details: '+bug' });
      stats.incrementTriaged();

      const json = stats.toJSON() as any;

      expect(json.schemaVersion).toBe(1);
      expect(json.repo).toBe('octo/demo');
      expect(json.models).toEqual({ fast: 'fast-model', pro: 'pro-model' });
      expect(json.github).toEqual({ calls: 12, retries: 0 });
      expect(json.funnel).toMatchObject({
        discovered: 100,
        processed: 2,
        triaged: 1,
        skipped: 1,
        failed: 0,
        escalatedToPro: 1,
        capReached: 'fast',
      });
      expect(json.funnel.skipReasons).toEqual({ 'noop-fast': 1 });
      expect(json.fast.thoughtsTokens).toBe(7000);
      expect(json.pro.thoughtsTokens).toBe(6000);
      expect(json.actions).toEqual({ total: 1, byKind: { add_labels: 1 } });

      const item1 = json.items.find((i: any) => i.number === 1);
      expect(item1).toMatchObject({ type: 'issue', outcome: 'skipped', skipReason: 'noop-fast', escalatedToPro: false });
      expect(item1.fast.thoughtsTokens).toBe(4000);
      expect(item1.pro).toBeNull();

      const item2 = json.items.find((i: any) => i.number === 2);
      expect(item2).toMatchObject({ type: 'pull request', outcome: 'triaged', escalatedToPro: true });
      expect(item2.pro.thoughtsTokens).toBe(6000);
      expect(item2.operations).toEqual(['add_labels']);
    });

    it('serializes an empty run without throwing', () => {
      expect(() => JSON.stringify(stats.toJSON())).not.toThrow();
      const json = stats.toJSON() as any;
      expect(json.funnel.capReached).toBe('none');
      expect(json.items).toEqual([]);
    });
  });
});
