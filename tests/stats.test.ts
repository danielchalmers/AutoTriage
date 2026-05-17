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

  describe('tracking model runs', () => {
  });

  describe('tracking actions', () => {
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
  });
});
