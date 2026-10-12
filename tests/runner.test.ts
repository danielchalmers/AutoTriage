import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const processIssueMock = vi.hoisted(() => vi.fn());
const githubContextMock = vi.hoisted(() => ({
  eventName: '',
  payload: {} as unknown,
  serverUrl: 'https://github.com',
}));

vi.mock('@actions/github', () => ({
  context: githubContextMock,
}));

// setFailed, warning and notice would otherwise print ::error::, ::warning:: and ::notice:: commands, which annotate the test job on GitHub, and setFailed would set process.exitCode for the test worker.
vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  setFailed: vi.fn(),
  warning: vi.fn(),
  notice: vi.fn(),
}));

vi.mock('../src/issueProcessor', async () => {
  const actual = await vi.importActual<typeof import('../src/issueProcessor')>('../src/issueProcessor');
  return {
    ...actual,
    processIssue: processIssueMock,
  };
});

import * as core from '@actions/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildAnalysisResultSchema } from '../src/analysis';
import type { Config } from '../src/config';
import { ConfigurationError } from '../src/failures';
import { ModelError } from '../src/llm/chat';
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt';
import { POLICY_PATH } from '../src/prompts';
import { listTargets, runAutoTriage } from '../src/runner';
import { ItemRecord, RunStatistics } from '../src/stats';
import { githubError, makeClosedIssue, makeConfig, makeDb, makeIssue, makePullRequest, makeSameRepoWorkflowRunEvent, withTempDir } from './fixtures';

const baseConfig = makeConfig();
const SHA = '0123456789abcdef0123456789abcdef01234567';

// The records processIssue returns.
const plan = { kinds: ['add_labels'], labels: ['+bug'] };
function triaged(issueNumber: number, overrides: Partial<ItemRecord> = {}): ItemRecord {
  return { issueNumber, type: 'issue', outcome: 'triaged', plan, ...overrides };
}
function deferred(issueNumber: number, overrides: Partial<ItemRecord> = {}): ItemRecord {
  return triaged(issueNumber, { outcome: 'deferred', ...overrides });
}
// Deferred because the item changed during analysis, which earns it one more analysis.
function changed(issueNumber: number, overrides: Partial<ItemRecord> = {}): ItemRecord {
  return deferred(issueNumber, { changedDuringAnalysis: true, detail: "It changed while it was being analyzed, so the plan wasn't applied.", ...overrides });
}

describe('listTargets', () => {
  function createGitHub() {
    return {
      listOpenIssues: vi.fn().mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z')]),
      listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
      getPullRequest: vi.fn(async (n: number) => makePullRequest(n)),
      listOpenPullRequestsByHead: vi.fn().mockResolvedValue([]),
      getLastReadyForReview: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('uses explicit issue inputs before any other source', async () => {
    const gh = createGitHub();

    const result = await listTargets({
      cfg: { ...baseConfig, issueNumbers: [3, 5] },
      db: makeDb(),
      gh,
      event: { name: 'issues', payload: { issue: { number: 99 } } },
    });

    expect(result).toEqual({ targets: [3, 5], autoDiscover: false });
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
  });

  it('uses the event payload target when no explicit inputs were provided', async () => {
    const gh = createGitHub();

    const result = await listTargets({
      cfg: baseConfig,
      db: makeDb(),
      gh,
      event: { name: 'pull_request_target', payload: { pull_request: { number: 77 } } },
    });

    expect(result).toEqual({ targets: [77], autoDiscover: false });
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
  });

  it('triages the pull request behind a workflow_run event and says how it was found, without sweeping', async () => {
    const gh = createGitHub();

    const result = await listTargets({ cfg: baseConfig, db: makeDb(), gh, event: makeSameRepoWorkflowRunEvent(12) });

    expect(result).toEqual({ targets: [12], autoDiscover: false, via: 'PR #12 (listed on the workflow run)' });
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
  });

  it('triages nothing for a push event instead of sweeping the backlog', async () => {
    const gh = createGitHub();

    const result = await listTargets({ cfg: baseConfig, db: makeDb(), gh, event: { name: 'push', payload: { ref: 'refs/heads/main' } } });

    expect(result).toEqual({ targets: [], autoDiscover: false, notice: expect.stringMatching(/^Nothing to triage for the push event/) });
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
  });

  it.each([
    ['a schedule event', { name: 'schedule', payload: { schedule: '23 8 * * *' } }],
    ['a workflow_dispatch event with blank issues', { name: 'workflow_dispatch', payload: { inputs: { issues: '' } } }],
    ['a local run with no event name', { name: undefined, payload: {} }],
  ])('sweeps the backlog for %s, skipping unchanged items outside extended mode', async (_name, event) => {
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue([
      makeIssue(5, '2024-04-05T00:00:00Z'),
      makeIssue(4, '2024-04-01T00:00:00Z'),
    ]);
    const db = makeDb({
      '4': { lastTriaged: '2024-04-02T00:00:00Z' },
    });

    const result = await listTargets({ cfg: baseConfig, db, gh, event });

    expect(result).toEqual({ targets: [5], autoDiscover: true });
    expect(gh.listRecentlyClosedIssues).not.toHaveBeenCalled();
  });

  it('includes re-check candidates from recently closed issues in extended mode', async () => {
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue([
      makeIssue(5, '2024-04-01T00:00:00Z'),
    ]);
    gh.listRecentlyClosedIssues.mockResolvedValue([
      makeClosedIssue(4, '2024-04-02T00:00:00Z', '2024-04-03T00:00:00Z'),
    ]);
    const db = makeDb({
      '4': { lastTriaged: '2024-04-01T00:00:00Z' },
      '5': { lastTriaged: '2024-04-02T00:00:00Z' },
    });

    const result = await listTargets({
      cfg: { ...baseConfig, extended: true },
      db,
      gh,
      event: { name: 'schedule', payload: {} },
    });

    expect(result).toEqual({ targets: [4, 5], autoDiscover: true });
    expect(gh.listRecentlyClosedIssues).toHaveBeenCalledOnce();
  });
});

describe('runAutoTriage', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let artifactsRoot: string;
  let summaryDir: string;
  let summaryFile: string;

  // @actions/core keeps the GITHUB_STEP_SUMMARY path from its first write, so every test writes its job summary to one file.
  beforeAll(() => {
    summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-summary-'));
    summaryFile = path.join(summaryDir, 'step-summary.md');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(summaryDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    githubContextMock.eventName = '';
    githubContextMock.payload = {};
    processIssueMock.mockReset();
    processIssueMock.mockImplementation(async (_deps, { issue }) => triaged(issue.number));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Run artifacts (system prompts, run summary) land in a throwaway directory instead of the repository root.
    artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-runner-'));
    vi.spyOn(process, 'cwd').mockReturnValue(artifactsRoot);
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    fs.writeFileSync(summaryFile, '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(artifactsRoot, { recursive: true, force: true });
  });

  function createStats() {
    return new RunStatistics();
  }

  function summaryOf(stats: RunStatistics) {
    return stats.toJSON() as any;
  }

  function createModel() {
    return { generateJson: vi.fn() };
  }

  function createGitHub() {
    return {
      listRootFiles: vi.fn().mockResolvedValue(['LICENSE', 'README.md']),
      readRepoFile: vi.fn(async (path: string): Promise<string | null> => (path === POLICY_PATH ? 'Label bugs.' : '# Project')),
      listRepoLabels: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi.fn().mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z')]),
      listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn(async (issueNumber: number) => makeIssue(issueNumber, '2024-04-05T00:00:00Z')),
      getPullRequest: vi.fn(async (n: number) => makePullRequest(n)),
      listOpenPullRequestsByHead: vi.fn().mockResolvedValue([]),
      getLastReadyForReview: vi.fn().mockResolvedValue(undefined),
      getApiCallCount: vi.fn().mockReturnValue(0),
    };
  }

  function run(cfg: Config, options: { gh?: ReturnType<typeof createGitHub>; stats?: RunStatistics } = {}) {
    return runAutoTriage({ cfg, db: makeDb(), gh: (options.gh ?? createGitHub()) as any, model: createModel(), stats: options.stats ?? createStats() });
  }

  function readJobSummary(): string {
    return fs.readFileSync(summaryFile, 'utf8');
  }

  function warnings(): string[] {
    return vi.mocked(core.warning).mock.calls.map(([message]) => String(message));
  }

  const issueLink = (n: number) => `<a href="https://github.com/owner/repo/issues/${n}">#${n}</a>`;

  it('tells each item whether it came from backlog auto-discovery', async () => {
    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: createGitHub() as any, model: createModel(), stats: createStats() });
    await runAutoTriage({ cfg: { ...baseConfig, issueNumbers: [5] }, db: makeDb(), gh: createGitHub() as any, model: createModel(), stats: createStats() });

    expect(processIssueMock.mock.calls.map(([, options]) => options.autoDiscover)).toEqual([true, false]);
  });

  it('builds the response schema once from the repository labels and hands the same one to every item', async () => {
    const gh = createGitHub();
    gh.listRepoLabels.mockResolvedValue([{ name: 'question' }, { name: 'bug' }]);

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { gh });

    const [first, second] = processIssueMock.mock.calls.map(([, options]) => options.schema);
    expect(second).toBe(first);
    expect(first).toEqual(buildAnalysisResultSchema([{ name: 'bug' }, { name: 'question' }]));
  });

  it('triages nothing for a push event, leaving a notice and a green run without reading labels or the backlog', async () => {
    githubContextMock.eventName = 'push';
    githubContextMock.payload = { ref: 'refs/heads/main' };
    const gh = createGitHub();
    const stats = createStats();

    await run(baseConfig, { gh, stats });

    const notice = 'Nothing to triage for the push event, because it names no issue or pull request and only schedule and workflow_dispatch events sweep the backlog.';
    expect(core.notice).toHaveBeenCalledExactlyOnceWith(notice);
    expect(gh.listRepoLabels).not.toHaveBeenCalled();
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
    expect(processIssueMock).not.toHaveBeenCalled();
    expect(summaryOf(stats).funnel).toMatchObject({ discovered: 0, processed: 0 });
    expect(readJobSummary()).toContain(`<p>ℹ️ ${notice}</p>`);
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('triages the pull request behind a workflow_run event and names it in the log and the job summary', async () => {
    const event = makeSameRepoWorkflowRunEvent(12);
    githubContextMock.eventName = 'workflow_run';
    githubContextMock.payload = event.payload;

    await run(baseConfig);

    expect(processIssueMock.mock.calls.map(([, options]) => [options.issue.number, options.autoDiscover])).toEqual([[12, false]]);
    expect(logSpy).toHaveBeenCalledWith('🔗 workflow_run event: PR #12 (listed on the workflow run)');
    expect(readJobSummary()).toContain('<li>Workflow run: PR #12 (listed on the workflow run)</li>');
    expect(core.notice).not.toHaveBeenCalled();
  });

  it('logs an explicit target list once', async () => {
    await runAutoTriage({ cfg: { ...baseConfig, issueNumbers: [5, 6] }, db: makeDb(), gh: createGitHub() as any, model: createModel(), stats: createStats() });

    const targetLines = (logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).filter((line) => line.startsWith('▶️'));
    expect(targetLines).toEqual(['▶️ Triaging 2 item(s): #5, #6']);
  });

  it('logs the size of an auto-discovered backlog instead of every number', async () => {
    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: createGitHub() as any, model: createModel(), stats: createStats() });

    const targetLines = (logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).filter((line) => line.startsWith('▶️'));
    expect(targetLines).toEqual([`▶️ Discovered 1 item(s) from ${baseConfig.owner}/${baseConfig.repo} (extended: false)`]);
  });

  it('saves the database after processing the item that reaches max-pro-runs', async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json');
      const gh = createGitHub();
      const model = createModel();
      const stats = createStats();

      await runAutoTriage({
        cfg: { ...baseConfig, dbPath, dryRun: false, issueNumbers: [5], maxProRuns: 1 },
        db: makeDb({ '5': { lastTriaged: '2024-04-01T00:00:00Z' } }),
        gh: gh as any,
        model,
        stats,
      });

      expect(JSON.parse(fs.readFileSync(dbPath, 'utf8'))).toEqual({
        version: 2,
        items: {
          '5': { lastTriaged: '2024-04-01T00:00:00Z' },
        },
      });
    });
  });

  it('logs remaining backlog items when max-pro-runs is reached, and lists them in the job summary without failing the job', async () => {
    const gh = createGitHub();
    const model = createModel();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      model,
      stats,
    });

    expect(logSpy).toHaveBeenCalledWith('⏳ Reached max-pro-runs (1) with 2 item(s) remaining');
    expect(summaryOf(stats).funnel.capReached).toBe(true);
    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(readJobSummary()).toContain(`⏳ Not reached because the run reached max-pro-runs (1): ${issueLink(6)}, ${issueLink(7)}.`);
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('does not spend max-pro-runs on an item that failed', async () => {
    processIssueMock.mockRejectedValueOnce(new ModelError('api.openai.com returned HTTP 503: busy', 'capacity'));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 1 }, { stats });

    expect(processIssueMock.mock.calls.map(([, options]) => options.issue.number)).toEqual([5, 6]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, failed: 1, capReached: true });
  });

  it('counts a deferred item apart from triaged ones while spending max-pro-runs on it', async () => {
    processIssueMock.mockResolvedValueOnce(deferred(5));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 2 },
      db: makeDb(),
      gh: createGitHub() as any,
      model: createModel(),
      stats,
    });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, deferred: 1, capReached: true });
    expect(logSpy).toHaveBeenCalledWith('  Total: ✅ 1 triaged ⏸️ 1 deferred');
  });

  it('warns about a deferred item and lists it in the job summary without failing the job', async () => {
    const detail = "It changed while it was being analyzed, so the plan wasn't applied.";
    processIssueMock.mockResolvedValueOnce({ ...deferred(5), detail });

    await run({ ...baseConfig, issueNumbers: [5, 6] });

    expect(warnings()).toEqual([`#5 deferred: ${detail}`]);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(readJobSummary()).toContain(`<tr><td>${issueLink(5)}</td><td>Deferred</td><td>It changed while it was being analyzed, so the plan wasn&#39;t applied.</td></tr>`);
  });

  it('analyzes an item that changed during analysis once more with its latest state', async () => {
    const gh = createGitHub();
    const renamed = makeIssue(5, '2024-04-06T00:00:00Z', { title: 'Renamed' });
    gh.getIssue
      .mockResolvedValueOnce(makeIssue(5, '2024-04-05T00:00:00Z'))
      .mockResolvedValueOnce(renamed);
    processIssueMock
      .mockResolvedValueOnce(changed(5))
      .mockResolvedValueOnce(triaged(5, { title: 'Renamed', reanalyzed: true }));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5] }, { gh, stats });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(processIssueMock.mock.calls[0]![1]).not.toHaveProperty('reanalysis');
    expect(processIssueMock.mock.calls[1]![1]).toMatchObject({ issue: renamed, reanalysis: true });
    expect(logSpy).toHaveBeenCalledWith('🔁 Analyzing #5 again, because it changed while it was being analyzed');
    expect(summaryOf(stats).items).toEqual([expect.objectContaining({ number: 5, outcome: 'triaged', reanalyzed: true })]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 1, triaged: 1, deferred: 0 });
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('defers an item that changed again during its re-analysis, without a third analysis', async () => {
    const detail = "It changed again while it was being re-analyzed, so the plan wasn't applied.";
    processIssueMock
      .mockResolvedValueOnce(changed(5))
      .mockResolvedValueOnce(changed(5, { reanalyzed: true, detail }));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { stats });

    expect(processIssueMock.mock.calls.map(([, options]) => options.issue.number)).toEqual([5, 5, 6]);
    expect(summaryOf(stats).items[0]).toMatchObject({ number: 5, outcome: 'deferred', reanalyzed: true });
    expect(warnings()).toEqual([`#5 deferred: ${detail}`]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('counts both analyses of a re-analyzed item against max-pro-runs', async () => {
    processIssueMock.mockResolvedValueOnce(changed(5));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 3 }, { stats });

    expect(processIssueMock.mock.calls.map(([, options]) => options.issue.number)).toEqual([5, 5, 6]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, capReached: true });
    expect(readJobSummary()).toContain(`⏳ Not reached because the run reached max-pro-runs (3): ${issueLink(7)}.`);
  });

  it('leaves a changed item deferred when max-pro-runs leaves no room to analyze it again', async () => {
    processIssueMock.mockResolvedValueOnce(changed(5));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6], maxProRuns: 1 }, { stats });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith("⏳ #5 isn't analyzed again, because the run reached max-pro-runs (1)");
    expect(summaryOf(stats).items).toEqual([expect.objectContaining({ number: 5, outcome: 'deferred' })]);
    expect(warnings()).toEqual(["#5 deferred: It changed while it was being analyzed, so the plan wasn't applied."]);
  });

  it('records a failed re-analysis as a failed item, after spending the budget of the first analysis', async () => {
    processIssueMock
      .mockResolvedValueOnce(changed(5))
      .mockRejectedValueOnce(new ModelError('api.openai.com returned HTTP 503: busy', 'capacity'));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 2 }, { stats });

    expect(summaryOf(stats).items[0]).toMatchObject({ number: 5, outcome: 'failed', reanalyzed: true, failureReason: 'capacity' });
    // The first analysis of #5 spent one run, so #6 spends the last one.
    expect(processIssueMock.mock.calls.map(([, options]) => options.issue.number)).toEqual([5, 5, 6]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, failed: 1, capReached: true });
    expect(warnings()).toEqual(['#5 failed: api.openai.com returned HTTP 503: busy']);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('continues past a GitHub failure on one item and finishes without failing the job', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stats = createStats();
    processIssueMock.mockRejectedValueOnce(githubError(502, 'Bad Gateway'));

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { stats });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(summaryOf(stats).items).toEqual([
      expect.objectContaining({ number: 5, outcome: 'failed', failureReason: 'other' }),
      expect.objectContaining({ number: 6, outcome: 'triaged' }),
    ]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, failed: 1 });
    expect(warnSpy).toHaveBeenCalledWith('#5: GitHub returned HTTP 502: Bad Gateway');
    expect(warnings()).toEqual(['#5 failed: GitHub returned HTTP 502: Bad Gateway']);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('records the title of an item that failed after it was fetched', async () => {
    const gh = createGitHub();
    gh.getIssue.mockResolvedValueOnce(makeIssue(5, '2024-04-05T00:00:00Z', { title: 'Crash on save', type: 'pull request' }));
    processIssueMock.mockRejectedValueOnce(new ModelError('api.openai.com returned HTTP 503: busy', 'capacity'));

    await run({ ...baseConfig, issueNumbers: [5] }, { gh });

    expect(readJobSummary()).toContain('<tr><td><a href="https://github.com/owner/repo/pull/5">#5</a></td><td>Failed</td><td>api.openai.com returned HTTP 503: busy</td></tr>');
  });

  it('stops after three items in a row fail, with a warning rather than a failed job', async () => {
    const stats = createStats();
    processIssueMock.mockRejectedValue(new ModelError('generativelanguage.googleapis.com returned HTTP 503: UNAVAILABLE', 'capacity'));

    await run({ ...baseConfig, issueNumbers: [5, 6, 7, 8, 9] }, { stats });

    expect(processIssueMock).toHaveBeenCalledTimes(3);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 3, failed: 3 });
    const failure = 'failed: generativelanguage.googleapis.com returned HTTP 503: UNAVAILABLE';
    expect(warnings()).toEqual([
      "Stopped the run after 3 items in a row failed, so 2 item(s) weren't attempted.",
      `#5 ${failure}`,
      `#6 ${failure}`,
      `#7 ${failure}`,
    ]);
    expect(core.setFailed).not.toHaveBeenCalled();
    const summary = readJobSummary();
    expect(summary).toContain('⚠️ Stopped the run after 3 items in a row failed, so 2 item(s) weren&#39;t attempted.');
    expect(summary).toContain(`⏳ Not reached because 3 items in a row failed: ${issueLink(8)}, ${issueLink(9)}.`);
  });

  it('resets the consecutive-failure breaker after a success', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = githubError(503, 'Service Unavailable');
    processIssueMock
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(triaged(3))
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);

    await run({ ...baseConfig, issueNumbers: [1, 2, 3, 4, 5, 6] });

    expect(processIssueMock).toHaveBeenCalledTimes(6);
    expect(warnSpy.mock.calls.filter(([message]) => String(message).includes('HTTP 503'))).toHaveLength(4);
  });

  it('logs model errors without a stack and records their kind', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new ModelError('Unable to parse JSON from the api.openai.com response'));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5] }, { stats });

    expect(warnSpy).toHaveBeenCalledWith('#5: Unable to parse JSON from the api.openai.com response');
    expect(summaryOf(stats).items).toEqual([
      expect.objectContaining({ number: 5, outcome: 'failed', failureReason: 'retryable' }),
    ]);
  });

  it('logs a model call that ran out of retries without a stack', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new ModelError('fetch failed (ECONNRESET)', 'capacity'));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5] }, { stats });

    expect(warnSpy).toHaveBeenCalledWith('#5: fetch failed (ECONNRESET)');
    expect(summaryOf(stats).items).toEqual([
      expect.objectContaining({ number: 5, outcome: 'failed', failureReason: 'capacity' }),
    ]);
  });

  it.each<[string, unknown]>([
    ['an overloaded model', new ModelError('api.anthropic.com returned HTTP 529: overloaded_error', 'capacity')],
    ['a model call that timed out', new ModelError('api.anthropic.com did not respond within 600s')],
    ['a refused reply', new ModelError('api.openai.com declined to answer: no', 'permanent')],
    ['a GitHub server error', githubError(500, 'Internal Server Error')],
    ['a GitHub network error', Object.assign(githubError(500, 'other side closed'), { response: undefined })],
    ['a GitHub rate limit', githubError(429, 'Too Many Requests')],
    ['an exhausted GitHub rate limit', githubError(403, 'API rate limit exceeded for installation.', { 'x-ratelimit-remaining': '0' })],
    ['a GitHub secondary rate limit', githubError(403, 'You have exceeded a secondary rate limit.')],
    ['an item GitHub no longer has', githubError(410, 'This issue was deleted')],
    ['a network error outside Octokit', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  ])('records %s as a failed item and goes on without failing the job', async (_name, error) => {
    const stats = createStats();
    processIssueMock.mockRejectedValueOnce(error);

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { stats });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(summaryOf(stats).funnel).toMatchObject({ triaged: 1, failed: 1 });
    expect(warnings()).toEqual([expect.stringMatching(/^#5 failed: /)]);
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('stops the run and fails the job on a fatal model error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z'), makeIssue(6, '2024-04-06T00:00:00Z')]);
    const stats = createStats();
    const printSummary = vi.spyOn(stats, 'printSummary');
    const message = 'api.openai.com returned HTTP 401: {"error":{"message":"Incorrect API key provided"}} Check OPENAI_API_KEY.';
    processIssueMock.mockRejectedValueOnce(new ModelError(message, 'fatal'));

    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: gh as any, model: createModel(), stats });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith(`Stopped the run at #5, because every later item would fail the same way: ${message}`);
    expect(summaryOf(stats).items).toEqual([expect.objectContaining({ outcome: 'failed', failureReason: 'fatal' })]);
    // The run still reports.
    expect(printSummary).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Incorrect API key'));
    expect(readJobSummary()).toContain('❌ Stopped the run at #5, because every later item would fail the same way: api.openai.com returned HTTP 401:');
  });

  it.each([
    [401, 'Bad credentials', ' Check the token in GITHUB_TOKEN.'],
    [403, 'Resource not accessible by integration', " Check that the token can reach this repository and that the workflow's permissions grant contents: read, issues: write and pull-requests: write."],
  ])('stops the run and fails the job when GitHub answers HTTP %i: %s', async (status, message, hint) => {
    processIssueMock.mockRejectedValueOnce(githubError(status, message));

    await run({ ...baseConfig, issueNumbers: [5, 6] });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith(`Stopped the run at #5, because every later item would fail the same way: GitHub returned HTTP ${status}: ${message}${hint}`);
    expect(readJobSummary()).toContain(`⏳ Not reached because the run stopped on a configuration error: ${issueLink(6)}.`);
  });

  it('fails the job when an item hits an unexpected error, and still processes the rest', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bug = new TypeError("Cannot read properties of undefined (reading 'labels')");
    processIssueMock.mockRejectedValueOnce(bug);
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { stats });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(`#5: unexpected error: ${bug.stack}`);
    expect(summaryOf(stats).items[0]).toMatchObject({ outcome: 'failed', failureReason: 'other' });
    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith(
      "1 item(s) failed because of a bug in AutoTriage, and the log has the stack for each. #5: Unexpected TypeError: Cannot read properties of undefined (reading 'labels')"
    );
  });

  it('warns and still reports without failing the job when GitHub fails before the first item', async () => {
    const gh = createGitHub();
    gh.listRepoLabels.mockRejectedValue(githubError(503, 'Service Unavailable'));
    const stats = createStats();
    const printSummary = vi.spyOn(stats, 'printSummary');

    await run(baseConfig, { gh, stats });

    expect(processIssueMock).not.toHaveBeenCalled();
    expect(warnings()).toEqual(["Triage didn't start: GitHub returned HTTP 503: Service Unavailable"]);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(printSummary).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(artifactsRoot, 'artifacts'))).toContain('run-summary.json');
    expect(readJobSummary()).toContain('⚠️ Triage didn&#39;t start: GitHub returned HTTP 503: Service Unavailable');
  });

  it('fails the job when GitHub rejects the token before the first item', async () => {
    const gh = createGitHub();
    gh.listRepoLabels.mockRejectedValue(githubError(401, 'Bad credentials'));

    await run(baseConfig, { gh });

    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith("Triage didn't start: GitHub returned HTTP 401: Bad credentials Check the token in GITHUB_TOKEN.");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('fails the job with the stack in the log when a bug stops the run before the first item', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gh = createGitHub();
    const bug = new TypeError('issues.concat is not a function');
    gh.listOpenIssues.mockRejectedValue(bug);

    await run(baseConfig, { gh });

    expect(errorSpy).toHaveBeenCalledWith(bug.stack);
    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith(
      'Triage stopped because of a bug in AutoTriage, and the log has the stack. Unexpected TypeError: issues.concat is not a function'
    );
  });

  it('writes a job summary with the run settings, the items acted on and the counts', async () => {
    processIssueMock.mockImplementation(async ({ stats }, { issue }) => {
      stats.trackAction({ issueNumber: issue.number, type: 'add_labels', details: 'labels: +bug' });
      return triaged(issue.number, { title: 'Crash when <b>saving</b> & loading' });
    });

    await run({ ...baseConfig, sha: SHA, issueNumbers: [5] });

    const summary = readJobSummary();
    expect(summary).toContain('<h2>AutoTriage</h2>');
    expect(summary).toContain('<li>Mode: dry run, so nothing was changed</li>');
    expect(summary).toContain('<li>Model: <code>test-model at api.openai.com</code></li>');
    expect(summary).toContain('<li>Policy: <code>.github/AutoTriage.prompt</code> at 0123456</li>');
    expect(summary).toContain('<li>README: <code>README.md</code> at 0123456</li>');
    expect(summary).toMatch(/<li>Prompt hash: <code>sha256:[0-9a-f]{16}<\/code><\/li>/);
    expect(summary).toContain('<h3>Planned</h3>');
    expect(summary).toContain(`<tr><td>${issueLink(5)}</td><td>Crash when &#60;b&#62;saving&#60;/b&#62; &#38; loading</td><td>labels: +bug</td></tr>`);
    expect(summary).toContain('Discovered 1 and processed 1: 1 triaged, 0 deferred and 0 failed.');
    expect(summary).not.toContain('Not finished');
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('reads the policy and README at the run\'s commit, and names them in the log', async () => {
    const gh = createGitHub();

    await run({ ...baseConfig, sha: SHA, issueNumbers: [5] }, { gh });

    expect(gh.listRootFiles).toHaveBeenCalledExactlyOnceWith(SHA);
    expect(gh.readRepoFile.mock.calls).toEqual([[POLICY_PATH, SHA], ['README.md', SHA]]);
    expect(logSpy).toHaveBeenCalledWith('📜 Policy: .github/AutoTriage.prompt at 0123456');
    expect(logSpy).toHaveBeenCalledWith('📖 README: README.md at 0123456');
  });

  it('uses the built-in policy and says so when the repository has no policy file or README', async () => {
    const gh = createGitHub();
    gh.listRootFiles.mockResolvedValue(['LICENSE']);
    gh.readRepoFile.mockResolvedValue(null);

    await run({ ...baseConfig, issueNumbers: [5] }, { gh });

    expect(processIssueMock.mock.calls[0]![1].systemPrompt).toContain(`=== SECTION: ASSISTANT BEHAVIOR POLICY ===\n${BUILTIN_LABEL_ONLY_PROMPT}\n`);
    expect(logSpy).toHaveBeenCalledWith('📜 Policy: built-in');
    expect(logSpy).toHaveBeenCalledWith('📖 README: none');
    const summary = readJobSummary();
    expect(summary).toContain('<li>Policy: built-in</li>');
    expect(summary).toContain('<li>README: none</li>');
  });

  it('stops green with a warning, and triages nothing, when a transient GitHub error keeps it from reading the policy', async () => {
    const gh = createGitHub();
    gh.readRepoFile.mockRejectedValueOnce(githubError(503, 'Service Unavailable'));

    await run({ ...baseConfig, sha: SHA, issueNumbers: [5] }, { gh });

    expect(warnings()).toEqual([
      "Triage didn't start, because the policy and README couldn't be read at 0123456, and the built-in policy doesn't stand in for a policy file that failed to load: GitHub returned HTTP 503: Service Unavailable",
    ]);
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(gh.listRepoLabels).not.toHaveBeenCalled();
    expect(processIssueMock).not.toHaveBeenCalled();
    const summary = readJobSummary();
    expect(summary).toContain('<p>⚠️ Triage didn&#39;t start, because the policy and README couldn&#39;t be read at 0123456,');
    expect(summary).not.toContain('Policy:');
  });

  it.each([
    [
      "the token can't list the repository's files",
      'listRootFiles',
      new ConfigurationError("Couldn't list the repository's files at 0123456: GitHub returned HTTP 404: Not Found."),
      "Triage didn't start: Couldn't list the repository's files at 0123456: GitHub returned HTTP 404: Not Found.",
    ],
    [
      'GitHub refuses to read the policy',
      'readRepoFile',
      githubError(403, 'Resource not accessible by integration'),
      "Triage didn't start: GitHub returned HTTP 403: Resource not accessible by integration Check that the token can reach this repository and that the workflow's permissions grant contents: read, issues: write and pull-requests: write.",
    ],
  ] as const)('fails the job and triages nothing when %s', async (_name, method, error, message) => {
    const gh = createGitHub();
    gh[method].mockRejectedValueOnce(error);

    await run({ ...baseConfig, sha: SHA, issueNumbers: [5] }, { gh });

    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith(message);
    expect(processIssueMock).not.toHaveBeenCalled();
  });

  it('hands every item the one system prompt, and writes it and the run summary as artifacts', async () => {
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { stats });

    const artifacts = path.join(artifactsRoot, 'artifacts');
    expect(fs.readdirSync(artifacts).sort()).toEqual(['prompt-system.md', 'run-summary.json']);
    const systemPrompt = fs.readFileSync(path.join(artifacts, 'prompt-system.md'), 'utf8');
    expect(systemPrompt).toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY ===\nLabel bugs.\n');
    expect(systemPrompt).toContain('=== SECTION: PROJECT README (MARKDOWN) ===\n# Project\n');
    expect(processIssueMock.mock.calls.map(([, options]) => options.systemPrompt)).toEqual([systemPrompt, systemPrompt]);
    const summary = JSON.parse(fs.readFileSync(path.join(artifacts, 'run-summary.json'), 'utf8'));
    expect(summary).toMatchObject({ schemaVersion: 5, funnel: { processed: 2, triaged: 2 }, items: [{ number: 5, outcome: 'triaged' }, { number: 6, outcome: 'triaged' }] });
    expect(summary.promptHash).toMatch(/^sha256:[0-9a-f]{16}$/);
  });
});
