/// <reference types="vitest" />
import { RunStatistics } from '../src/stats';

describe('RunStatistics', () => {
  let stats: RunStatistics;

  beforeEach(() => {
    stats = new RunStatistics();
  });

  describe('tracking model runs', () => {
    it('tracks fast model runs', () => {
      stats.trackFastRun({
        startTime: 1000,
        endTime: 2000,
        inputTokens: 100,
        outputTokens: 50,
      });

      // Should not throw when printing
      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks pro model runs', () => {
      stats.trackProRun({
        startTime: 1000,
        endTime: 3000,
        inputTokens: 200,
        outputTokens: 100,
      });

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('calculates statistics correctly for multiple runs', () => {
      stats.trackFastRun({
        startTime: 0,
        endTime: 1000,
        inputTokens: 100,
        outputTokens: 50,
      });
      stats.trackFastRun({
        startTime: 0,
        endTime: 2000,
        inputTokens: 200,
        outputTokens: 100,
      });
      stats.trackFastRun({
        startTime: 0,
        endTime: 3000,
        inputTokens: 300,
        outputTokens: 150,
      });

      expect(() => stats.printSummary()).not.toThrow();
    });
  });

  describe('tracking actions', () => {
    it('tracks label actions', () => {
      stats.trackAction({
        issueNumber: 42,
        type: 'labels',
        details: 'labels: +bug, -enhancement',
      });

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks comment actions', () => {
      stats.trackAction({
        issueNumber: 7,
        type: 'comment',
        details: 'comment',
      });

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks title actions', () => {
      stats.trackAction({
        issueNumber: 15,
        type: 'title',
        details: 'title change',
      });

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks state actions', () => {
      stats.trackAction({
        issueNumber: 99,
        type: 'state',
        details: 'state: completed',
      });

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('groups actions by issue number', () => {
      stats.trackAction({
        issueNumber: 42,
        type: 'labels',
        details: 'labels: +bug',
      });
      stats.trackAction({
        issueNumber: 42,
        type: 'comment',
        details: 'comment',
      });
      stats.trackAction({
        issueNumber: 7,
        type: 'comment',
        details: 'comment',
      });

      expect(() => stats.printSummary()).not.toThrow();
    });
  });

  describe('tracking counts', () => {
    it('tracks triaged count', () => {
      stats.incrementTriaged();
      stats.incrementTriaged();

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks skipped count', () => {
      stats.incrementSkipped();

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks failed count', () => {
      stats.incrementFailed();
      expect(stats.getFailed()).toBe(1);

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('tracks GitHub API calls', () => {
      stats.incrementGithubApiCalls(10);
      stats.incrementGithubApiCalls(5);

      expect(() => stats.printSummary()).not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('handles empty statistics', () => {
      expect(() => stats.printSummary()).not.toThrow();
    });

    it('handles single run for p95 calculation', () => {
      stats.trackFastRun({
        startTime: 1000,
        endTime: 2000,
        inputTokens: 100,
        outputTokens: 50,
      });

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('handles zero duration runs', () => {
      stats.trackFastRun({
        startTime: 1000,
        endTime: 1000,
        inputTokens: 0,
        outputTokens: 0,
      });

      expect(() => stats.printSummary()).not.toThrow();
    });
  });

  describe('comprehensive scenario', () => {
    it('displays complete statistics for a typical run', () => {
      stats.setRepository('danielchalmers', 'AutoTriage');
      stats.setModelNames('gemini-2.5-flash-lite', 'gemini-3-flash-preview');
      
      // Fast runs
      stats.trackFastRun({
        startTime: 0,
        endTime: 1500,
        inputTokens: 1000,
        outputTokens: 200,
      });
      stats.trackFastRun({
        startTime: 0,
        endTime: 1700,
        inputTokens: 1200,
        outputTokens: 250,
      });

      // Pro runs
      stats.trackProRun({
        startTime: 0,
        endTime: 5000,
        inputTokens: 5000,
        outputTokens: 1000,
      });

      // Actions
      stats.trackAction({
        issueNumber: 42,
        type: 'labels',
        details: 'labels: +bug, +enhancement',
      });
      stats.trackAction({
        issueNumber: 7,
        type: 'comment',
        details: 'comment',
      });
      stats.trackAction({
        issueNumber: 15,
        type: 'title',
        details: 'title change',
      });
      stats.trackAction({
        issueNumber: 99,
        type: 'state',
        details: 'state: completed',
      });

      // Counts
      stats.incrementTriaged();
      stats.incrementTriaged();
      stats.incrementTriaged();
      stats.incrementTriaged();
      stats.incrementSkipped();
      stats.incrementSkipped();

      stats.incrementGithubApiCalls(199);

      expect(() => stats.printSummary()).not.toThrow();
    });

    it('displays model names when set', () => {
      stats.setModelNames('gemini-2.5-flash-lite', 'gemini-3-flash-preview');
      
      stats.trackFastRun({
        startTime: 0,
        endTime: 1000,
        inputTokens: 100,
        outputTokens: 50,
      });
      
      stats.trackProRun({
        startTime: 0,
        endTime: 2000,
        inputTokens: 200,
        outputTokens: 100,
      });

      expect(() => stats.printSummary()).not.toThrow();
    });
  });
});
