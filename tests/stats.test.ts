/// <reference types="vitest" />
import { RunStatistics, comparePlans, summarizePlan } from '../src/stats';

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
      stats.recordItem({ issueNumber: 3, outcome: 'triaged', escalatedToPro: true });
      stats.recordItem({ issueNumber: 12, outcome: 'triaged', escalatedToPro: true });
      stats.recordItem({ issueNumber: 20, outcome: 'skipped', escalatedToPro: false });
      stats.recordItem({ issueNumber: 21, outcome: 'deferred', escalatedToPro: true });
      stats.recordItem({ issueNumber: 22, outcome: 'failed', escalatedToPro: false, failureReason: 'other' });
      stats.trackAction({ issueNumber: 12, type: 'comment', details: 'comment' });
      stats.trackAction({ issueNumber: 3, type: 'add_labels', details: 'labels: +bug' });
      stats.trackAction({ issueNumber: 12, type: 'set_state', details: 'state: completed' });

      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toContain('  Total: ✅ 2 triaged ℹ️ 1 skipped ⏸️ 1 deferred ❌ 1 failed');
      const actionLines = lines.filter(line => line.startsWith('  #'));
      expect(actionLines).toEqual(['  #3: labels: +bug', '  #12: comment, state: completed']);
    });

    it('formats run durations', () => {
      stats.setModelNames('', 'pro-model');
      stats.trackProRun({ startTime: 0, endTime: 400, inputTokens: 1, outputTokens: 1 });
      stats.trackProRun({ startTime: 0, endTime: 125000, inputTokens: 1, outputTokens: 1 });

      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toContainEqual(expect.stringContaining('Pro (pro-model)'));
      expect(lines).toContain('    Total: 2m5s • Avg: 1m2s • p95: 2m5s');
    });
  });

  describe('comprehensive scenario', () => {
    it('summarizes cached input with its share of the input', () => {
      stats.setModelNames('gemini-3.5-flash-lite', 'gemini-3-flash-preview');
      stats.trackProRun({
        startTime: 0,
        endTime: 25700,
        inputTokens: 10800,
        cachedInputTokens: 8200,
        outputTokens: 257,
      });

      const lines = captureSummaryOutput(() => stats.printSummary());
      const tokenLine = lines.find(line => line.includes('Tokens:'));
      const cacheLine = lines.find(line => line.includes('Cache:'));

      expect(tokenLine).toContain('Tokens: 10.8k input • 257 output');
      expect(cacheLine).toContain('Cache: 8.2k (75.9%) reused');
    });

    it('shows GitHub API calls', () => {
      stats.incrementGithubApiCalls(15);

      const lines = captureSummaryOutput(() => stats.printSummary());

      expect(lines).toContain('  GitHub API: 15 calls');
    });

    it('reports reasoning tokens on the token line when present', () => {
      stats.setModelNames('', 'pro-model');
      stats.trackProRun({
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

  describe('toJSON run summary', () => {
    it('captures the funnel, per-pass reasoning tokens, and per-item rows', () => {
      stats.setRepository('octo', 'demo');
      stats.setModelNames('fast-model', 'pro-model');
      stats.setDiscovered(100);
      stats.setCapReached('fast');
      stats.incrementGithubApiCalls(12);
      stats.setRunConfig({
        dryRun: false,
        extended: true,
        skipFastPass: false,
        maxFastRuns: 30,
        maxProRuns: 20,
      });
      stats.setPromptHashes({ fast: 'sha256:aaaa', pro: 'sha256:bbbb' });

      // Item 1: fast pass gates it out (no escalation).
      stats.trackFastRun({
        startTime: 0,
        endTime: 1000,
        inputTokens: 9000,
        cachedInputTokens: 6000,
        outputTokens: 5,
        reasoningTokens: 4000,
        issueNumber: 1,
      });
      stats.recordItem({
        issueNumber: 1,
        type: 'issue',
        outcome: 'skipped',
        escalatedToPro: false,
        fastPlan: { kinds: [], labels: [] },
        agreement: 'fast-noop',
      });

      // Item 2: escalates to pro, triaged, performs an action.
      stats.trackFastRun({
        startTime: 0,
        endTime: 2000,
        inputTokens: 9000,
        cachedInputTokens: 6000,
        outputTokens: 8,
        reasoningTokens: 3000,
        issueNumber: 2,
      });
      stats.trackProRun({
        startTime: 0,
        endTime: 5000,
        inputTokens: 11000,
        cachedInputTokens: 8000,
        outputTokens: 120,
        reasoningTokens: 6000,
        issueNumber: 2,
      });
      stats.recordItem({
        issueNumber: 2,
        type: 'pull request',
        outcome: 'triaged',
        escalatedToPro: true,
        fastPlan: { kinds: ['add_labels'], labels: ['+bug'] },
        proPlan: { kinds: ['add_labels'], labels: ['+bug'] },
        agreement: 'identical',
      });
      stats.trackAction({ issueNumber: 2, type: 'add_labels', details: '+bug' });

      // Item 3: escalated but the pro call failed.
      stats.recordItem({ issueNumber: 3, outcome: 'failed', escalatedToPro: true, failedPass: 'pro', failureReason: 'capacity' });

      // Item 4: reviewed without a fast pass, then deferred because it changed during analysis.
      // Its title and reason are for the job summary, so the artifact leaves them out.
      stats.recordItem({
        issueNumber: 4,
        type: 'issue',
        title: 'Crash on save',
        outcome: 'deferred',
        escalatedToPro: true,
        proPlan: { kinds: ['comment'], labels: [] },
        detail: 'It changed while it was being analyzed.',
      });

      const json = stats.toJSON() as any;

      expect(json.schemaVersion).toBe(5);
      expect(json.repo).toBe('octo/demo');
      expect(json.models).toEqual({ fast: 'fast-model', pro: 'pro-model' });
      expect(json.config).toMatchObject({ maxFastRuns: 30 });
      expect(json.promptHash).toEqual({ fast: 'sha256:aaaa', pro: 'sha256:bbbb' });
      expect(json.github).toEqual({ calls: 12 });
      expect(json.funnel).toEqual({
        discovered: 100,
        processed: 4,
        triaged: 1,
        skipped: 1,
        deferred: 1,
        failed: 1,
        escalatedToPro: 3,
        capReached: 'fast',
        planAgreement: { 'fast-noop': 1, identical: 1 },
      });
      expect(json.fast.reasoningTokens).toBe(7000);
      expect(json.pro.reasoningTokens).toBe(6000);
      expect(json.actions).toEqual({ total: 1, byKind: { add_labels: 1 } });

      expect(json.items.map((i: any) => i.number)).toEqual([1, 2, 3, 4]);
      const item1 = json.items.find((i: any) => i.number === 1);
      expect(item1).toMatchObject({ type: 'issue', outcome: 'skipped', escalatedToPro: false });
      expect(item1.fast.reasoningTokens).toBe(4000);
      expect(item1.pro).toBeNull();

      const item2 = json.items.find((i: any) => i.number === 2);
      expect(item2).toMatchObject({ type: 'pull request', outcome: 'triaged', escalatedToPro: true, agreement: 'identical' });
      expect(item2.fastPlan).toEqual({ kinds: ['add_labels'], labels: ['+bug'] });
      expect(item2.pro.reasoningTokens).toBe(6000);
      expect(item2.operations).toEqual(['add_labels']);

      const item3 = json.items.find((i: any) => i.number === 3);
      expect(item3).toMatchObject({ outcome: 'failed', escalatedToPro: true, failedPass: 'pro', failureReason: 'capacity' });
      expect(JSON.stringify(item2)).not.toContain('failureReason');

      const item4 = json.items.find((i: any) => i.number === 4);
      expect(JSON.parse(JSON.stringify(item4))).toEqual({
        number: 4,
        type: 'issue',
        outcome: 'deferred',
        escalatedToPro: true,
        proPlan: { kinds: ['comment'], labels: [] },
        fast: null,
        pro: null,
        operations: [],
      });
    });

    it('serializes an empty run without throwing', () => {
      expect(() => JSON.stringify(stats.toJSON())).not.toThrow();
      const json = stats.toJSON() as any;
      expect(json.funnel.capReached).toBe('none');
      expect(json.items).toEqual([]);
      expect(json.funnel).toMatchObject({ processed: 0, triaged: 0, skipped: 0, deferred: 0, failed: 0, escalatedToPro: 0 });
      expect(json.config).toBeNull();
      expect(json.promptHash).toBeNull();
    });

  });

  describe('plan summarization', () => {
    it('summarizes and compares plans', () => {
      const fast = summarizePlan([
        { kind: 'comment' },
        { kind: 'add_labels', labels: ['regression', 'bug'] },
        { kind: 'remove_labels', labels: ['stale'] },
      ]);
      expect(fast).toEqual({
        kinds: ['add_labels', 'comment', 'remove_labels'],
        labels: ['+bug', '+regression', '-stale'],
      });
      expect(comparePlans(fast, { kinds: [], labels: [] })).toBe('pro-vetoed');
      expect(comparePlans(fast, fast)).toBe('identical');
      expect(comparePlans(fast, { kinds: ['add_labels'], labels: ['+bug'] })).toBe('differed');
    });
  });
});
