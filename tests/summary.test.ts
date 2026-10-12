import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// warning would otherwise print ::warning:: commands, which annotate the test job on GitHub.
vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  warning: vi.fn(),
}));

import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ItemRecord, RunStatistics } from '../src/stats';
import { RunReport, annotateItems, writeJobSummary } from '../src/summary';
import { makeConfig } from './fixtures';

function failed(issueNumber: number, detail = 'api.openai.com returned HTTP 503: busy'): ItemRecord {
  return { issueNumber, outcome: 'failed', failureReason: 'capacity', detail };
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return { sources: { at: 'abc1234', policy: '.github/AutoTriage.prompt', readme: 'README.md' }, failures: [], warnings: [], notices: [], ...overrides };
}

function warnings(): string[] {
  return vi.mocked(core.warning).mock.calls.map(([message]) => String(message));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('annotateItems', () => {
  it('warns once for each failed or deferred item, and not for finished ones, even with dropped labels', () => {
    annotateItems([
      failed(3),
      { issueNumber: 4, outcome: 'triaged' },
      { issueNumber: 5, outcome: 'triaged', droppedLabels: ['+stale'] },
      { issueNumber: 6, outcome: 'deferred', detail: 'It changed while it was being analyzed.' },
      { issueNumber: 7, outcome: 'failed', failureReason: 'other', detail: 'GitHub returned HTTP 404: Not Found' },
    ], 0);

    expect(warnings()).toEqual([
      '#3 failed: api.openai.com returned HTTP 503: busy',
      '#6 deferred: It changed while it was being analyzed.',
      '#7 failed: GitHub returned HTTP 404: Not Found',
    ]);
  });

  it('warns for up to 10 items one by one', () => {
    annotateItems(Array.from({ length: 10 }, (_, i) => failed(i + 1)), 0);

    expect(warnings()).toHaveLength(10);
    expect(warnings()[9]).toBe('#10 failed: api.openai.com returned HTTP 503: busy');
  });

  it('merges the items past GitHub\'s limit of 10 warnings into one', () => {
    annotateItems(Array.from({ length: 12 }, (_, i) => failed(i + 1)), 0);

    expect(warnings()).toHaveLength(10);
    expect(warnings()[8]).toBe('#9 failed: api.openai.com returned HTTP 503: busy');
    expect(warnings()[9]).toBe('3 more items failed or were deferred: #10, #11, #12. The job summary says why.');
  });

  it('leaves room for the run\'s own warnings', () => {
    annotateItems(Array.from({ length: 10 }, (_, i) => failed(i + 1)), 1);

    expect(warnings()).toHaveLength(9);
    expect(warnings()[8]).toBe('2 more items failed or were deferred: #9, #10. The job summary says why.');
  });

  it('cuts a long reason short', () => {
    annotateItems([failed(3, `api.openai.com returned HTTP 500: ${'x'.repeat(1000)}`)], 0);

    expect(warnings()[0]!.length).toBeLessThan(340);
    expect(warnings()[0]).toMatch(/x…$/);
  });
});

describe('writeJobSummary', () => {
  let summaryDir: string;
  let summaryFile: string;

  // @actions/core keeps the GITHUB_STEP_SUMMARY path from its first write, so every test writes to one file.
  beforeAll(() => {
    summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-summary-'));
    summaryFile = path.join(summaryDir, 'step-summary.md');
  });

  beforeEach(() => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    fs.writeFileSync(summaryFile, '');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(summaryDir, { recursive: true, force: true });
  });

  const read = () => fs.readFileSync(summaryFile, 'utf8');

  it('lists what was acted on, what didn\'t finish and why, and the counts', async () => {
    const stats = new RunStatistics();
    stats.setDiscovered(60);
    stats.setPromptHash('sha256:0123456789abcdef');
    stats.recordItem({ issueNumber: 2, type: 'pull request', title: 'Fix "quotes" in <Button>', outcome: 'triaged' });
    stats.trackAction({ issueNumber: 2, type: 'add_labels', details: 'labels: +bug' });
    stats.trackAction({ issueNumber: 2, type: 'comment', details: 'comment' });
    stats.recordItem({ ...failed(3, 'api.openai.com returned HTTP 500: <html>oops</html>'), title: 'Crash' });
    stats.recordItem({ issueNumber: 4, outcome: 'deferred', detail: 'It changed while it was being analyzed.' });
    stats.trackModelRun({ startTime: 0, endTime: 10, inputTokens: 12345, cachedInputTokens: 2000, outputTokens: 50, reasoningTokens: 700 });
    const notReached = Array.from({ length: 53 }, (_, i) => i + 10);

    await writeJobSummary(
      makeConfig({ dryRun: false }),
      stats,
      report({ notReached: { items: notReached, reason: '3 items in a row failed' } })
    );

    const summary = read();
    expect(summary).toContain('<li>Mode: live</li>');
    expect(summary).toContain('<li>Model: <code>test-model at api.openai.com</code></li>');
    expect(summary).toContain('<li>Policy: <code>.github/AutoTriage.prompt</code> at abc1234</li>');
    expect(summary).toContain('<li>README: <code>README.md</code> at abc1234</li>');
    expect(summary).toContain('<li>Prompt hash: <code>sha256:0123456789abcdef</code></li>');
    expect(summary).toContain('<h3>Acted on</h3>');
    expect(summary).toContain('<tr><td><a href="https://github.com/owner/repo/pull/2">#2</a></td><td>Fix &#34;quotes&#34; in &#60;Button&#62;</td><td>labels: +bug, comment</td></tr>');
    expect(summary).toContain('<tr><td><a href="https://github.com/owner/repo/issues/3">#3</a></td><td>Failed</td><td>api.openai.com returned HTTP 500: &#60;html&#62;oops&#60;/html&#62;</td></tr>');
    expect(summary).toContain('<tr><td><a href="https://github.com/owner/repo/issues/4">#4</a></td><td>Deferred</td><td>It changed while it was being analyzed.</td></tr>');
    expect(summary).toContain('⏳ Not reached because 3 items in a row failed: <a href="https://github.com/owner/repo/issues/10">#10</a>, ');
    expect(summary).toContain('<a href="https://github.com/owner/repo/issues/59">#59</a> and 3 more.');
    expect(summary).not.toContain('issues/60"');
    expect(summary).toContain('Discovered 60 and processed 3: 1 triaged, 1 deferred and 1 failed.');
    expect(summary).not.toContain('left for the next sweep');
    expect(summary).not.toContain('Dropped labels');
    expect(summary).toContain('<tr><th>Model calls</th><th>Input tokens</th><th>Cached input</th><th>Output tokens</th><th>Reasoning tokens</th></tr>');
    expect(summary).toContain('<tr><td>1</td><td>12,345</td><td>2,000</td><td>50</td><td>700</td></tr>');
  });

  it("names the labels each item's plan dropped, escaped", async () => {
    const stats = new RunStatistics();
    stats.recordItem({ issueNumber: 6, type: 'issue', title: 'Old <crash>', outcome: 'triaged', droppedLabels: ['+stale', '-needs: <info>'] });
    stats.recordItem({ issueNumber: 7, type: 'pull request', title: 'Fix typo', outcome: 'triaged', plan: { kinds: ['add_labels'], labels: ['+bug'] } });

    await writeJobSummary(makeConfig(), stats, report());

    const summary = read();
    expect(summary).toContain('<h3>Dropped labels</h3>');
    expect(summary).toContain('<tr><th>Item</th><th>Title</th><th>Labels</th></tr><tr><td><a href="https://github.com/owner/repo/issues/6">#6</a></td><td>Old &#60;crash&#62;</td><td>+stale, -needs: &#60;info&#62;</td></tr></table>');
    expect(summary).not.toContain('pull/7');
  });

  it('says how many items a sweep left for the next sweep', async () => {
    const stats = new RunStatistics();
    stats.setDiscovered(45, 15);

    await writeJobSummary(makeConfig(), stats, report());

    const summary = read();
    expect(summary).toContain('<p>Discovered 45 and processed 0: 0 triaged, 0 deferred and 0 failed.</p>');
    expect(summary).toContain('<p>⏳ A sweep triages at most 30 items, so 15 were left for the next sweep.</p>');
  });

  it('names the built-in policy and a missing README', async () => {
    await writeJobSummary(makeConfig(), new RunStatistics(), report({ sources: { at: 'the default branch', policy: null, readme: null } }));

    const summary = read();
    expect(summary).toContain('<li>Policy: built-in</li>');
    expect(summary).toContain('<li>README: none</li>');
  });

  it('shows the run\'s failures and warnings, escaped, and no policy when the run stopped before reading it', async () => {
    await writeJobSummary(makeConfig(), new RunStatistics(), {
      failures: ['Stopped the run at #5: <bad key>'],
      warnings: ['Triage didn\'t start'],
      notices: [],
    });

    const summary = read();
    expect(summary).not.toContain('Policy:');
    expect(summary).not.toContain('README:');
    expect(summary).toContain('<p>❌ Stopped the run at #5: &#60;bad key&#62;</p>');
    expect(summary).toContain('<p>⚠️ Triage didn&#39;t start</p>');
    expect(summary).not.toContain('Prompt hash');
    expect(summary).not.toContain('Model calls');
  });

  it('names the pull request behind a workflow_run event, and shows why a run had nothing to triage, escaped', async () => {
    await writeJobSummary(makeConfig(), new RunStatistics(), report({
      workflowRun: 'PR #12 (fork lookup by pat:<fix>, head SHA matched)',
      notices: ['PR #12 is a draft, so the workflow_run event has nothing to triage.'],
    }));

    const summary = read();
    expect(summary).toContain('<li>Workflow run: PR #12 (fork lookup by pat:&#60;fix&#62;, head SHA matched)</li>');
    expect(summary).toContain('<p>ℹ️ PR #12 is a draft, so the workflow_run event has nothing to triage.</p>');
  });

  it('writes nothing outside GitHub Actions', async () => {
    vi.stubEnv('GITHUB_STEP_SUMMARY', '');

    await writeJobSummary(makeConfig(), new RunStatistics(), report());

    expect(read()).toBe('');
  });
});
