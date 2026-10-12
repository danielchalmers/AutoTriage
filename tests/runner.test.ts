import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const processIssueMock = vi.hoisted(() => vi.fn());
const githubContextMock = vi.hoisted(() => ({
  payload: {},
  serverUrl: 'https://github.com',
}));

vi.mock('@actions/github', () => ({
  context: githubContextMock,
}));

// setFailed and warning would otherwise print ::error:: and ::warning:: commands, which annotate the test job on GitHub, and setFailed would set process.exitCode for the test worker.
vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  setFailed: vi.fn(),
  warning: vi.fn(),
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
import { ModelError } from '../src/llm/chat';
import { listTargets, runAutoTriage } from '../src/runner';
import { ItemRecord, RunStatistics } from '../src/stats';
import { githubError, makeClosedIssue, makeConfig, makeDb, makeIssue, withArtifactsDir, withTempDir } from './fixtures';

const baseConfig = makeConfig();

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
  it('uses explicit issue inputs before any other source', async () => {
    const gh = {
      listOpenIssues: vi.fn(),
      listRecentlyClosedIssues: vi.fn(),
    };

    const result = await listTargets({
      cfg: { ...baseConfig, issueNumbers: [3, 5] },
      db: makeDb(),
      gh,
      payload: { issue: { number: 99 } },
    });

    expect(result).toEqual({ targets: [3, 5], autoDiscover: false });
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
  });

  it('uses the event payload target when no explicit inputs were provided', async () => {
    const gh = {
      listOpenIssues: vi.fn(),
      listRecentlyClosedIssues: vi.fn(),
    };

    const result = await listTargets({
      cfg: baseConfig,
      db: makeDb(),
      gh,
      payload: { pull_request: { number: 77 } },
    });

    expect(result).toEqual({ targets: [77], autoDiscover: false });
    expect(gh.listOpenIssues).not.toHaveBeenCalled();
  });

  it('falls back to auto-discovery and skips unchanged items outside extended mode', async () => {
    const gh = {
      listOpenIssues: vi.fn().mockResolvedValue([
        makeIssue(5, '2024-04-05T00:00:00Z'),
        makeIssue(4, '2024-04-01T00:00:00Z'),
      ]),
      listRecentlyClosedIssues: vi.fn(),
    };
    const db = makeDb({
      '4': { lastTriaged: '2024-04-02T00:00:00Z' },
    });

    const result = await listTargets({
      cfg: baseConfig,
      db,
      gh,
      payload: {},
    });

    expect(result).toEqual({ targets: [5], autoDiscover: true });
    expect(gh.listRecentlyClosedIssues).not.toHaveBeenCalled();
  });

  it('includes re-check candidates from recently closed issues in extended mode', async () => {
    const gh = {
      listOpenIssues: vi.fn().mockResolvedValue([
        makeIssue(5, '2024-04-01T00:00:00Z'),
      ]),
      listRecentlyClosedIssues: vi.fn().mockResolvedValue([
        makeClosedIssue(4, '2024-04-02T00:00:00Z', '2024-04-03T00:00:00Z'),
      ]),
    };
    const db = makeDb({
      '4': { lastTriaged: '2024-04-01T00:00:00Z' },
      '5': { lastTriaged: '2024-04-02T00:00:00Z' },
    });

    const result = await listTargets({
      cfg: { ...baseConfig, extended: true },
      db,
      gh,
      payload: {},
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
      listRepoLabels: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi.fn().mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z')]),
      listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn(async (issueNumber: number) => makeIssue(issueNumber, '2024-04-05T00:00:00Z')),
      getApiCallCount: vi.fn().mockReturnValue(0),
      hasFile: vi.fn().mockResolvedValue(false),
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

  it('saves the database after processing the item that reaches max-runs', async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json');
      const gh = createGitHub();
      const model = createModel();
      const stats = createStats();

      await runAutoTriage({
        cfg: { ...baseConfig, dbPath, dryRun: false, issueNumbers: [5], maxRuns: 1 },
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

  it('logs remaining items when max-runs is reached in an explicit list, and lists them in the job summary without failing the job', async () => {
    const gh = createGitHub();
    const model = createModel();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      model,
      stats,
    });

    expect(logSpy).toHaveBeenCalledWith('⏳ Reached max-runs (1) with 2 item(s) remaining');
    expect(summaryOf(stats).funnel.capReached).toBe(true);
    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(readJobSummary()).toContain(`⏳ Not reached because the run reached max-runs (1): ${issueLink(6)}, ${issueLink(7)}.`);
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('stops a backlog sweep after 50 analyses by default', async () => {
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue(Array.from({ length: 52 }, (_, i) => makeIssue(i + 1, '2024-04-05T00:00:00Z')));
    const stats = createStats();

    await run(baseConfig, { gh, stats });

    expect(processIssueMock).toHaveBeenCalledTimes(50);
    expect(summaryOf(stats).funnel).toMatchObject({ discovered: 52, processed: 50, capReached: true });
    expect(readJobSummary()).toContain(`⏳ Not reached because the run reached max-runs (50): ${issueLink(51)}, ${issueLink(52)}.`);
  });

  it('does not spend max-runs on an item that failed', async () => {
    processIssueMock.mockRejectedValueOnce(new ModelError('api.openai.com returned HTTP 503: busy', 'capacity'));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6, 7], maxRuns: 1 }, { stats });

    expect(processIssueMock.mock.calls.map(([, options]) => options.issue.number)).toEqual([5, 6]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, failed: 1, capReached: true });
  });

  it('counts a deferred item apart from triaged ones while spending max-runs on it', async () => {
    processIssueMock.mockResolvedValueOnce(deferred(5));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxRuns: 2 },
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

  it('counts both analyses of a re-analyzed item against max-runs', async () => {
    processIssueMock.mockResolvedValueOnce(changed(5));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6, 7], maxRuns: 3 }, { stats });

    expect(processIssueMock.mock.calls.map(([, options]) => options.issue.number)).toEqual([5, 5, 6]);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, capReached: true });
    expect(readJobSummary()).toContain(`⏳ Not reached because the run reached max-runs (3): ${issueLink(7)}.`);
  });

  it('leaves a changed item deferred when max-runs leaves no room to analyze it again', async () => {
    processIssueMock.mockResolvedValueOnce(changed(5));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6], maxRuns: 1 }, { stats });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith("⏳ #5 isn't analyzed again, because the run reached max-runs (1)");
    expect(summaryOf(stats).items).toEqual([expect.objectContaining({ number: 5, outcome: 'deferred' })]);
    expect(warnings()).toEqual(["#5 deferred: It changed while it was being analyzed, so the plan wasn't applied."]);
  });

  it('records a failed re-analysis as a failed item, after spending max-runs on the first analysis', async () => {
    processIssueMock
      .mockResolvedValueOnce(changed(5))
      .mockRejectedValueOnce(new ModelError('api.openai.com returned HTTP 503: busy', 'capacity'));
    const stats = createStats();

    await run({ ...baseConfig, issueNumbers: [5, 6, 7], maxRuns: 2 }, { stats });

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

    await run({ ...baseConfig, issueNumbers: [5] });

    const summary = readJobSummary();
    expect(summary).toContain('<h2>AutoTriage</h2>');
    expect(summary).toContain('<li>Mode: dry run, so nothing was changed</li>');
    expect(summary).toContain('<li>Model: <code>test-model at api.openai.com</code></li>');
    expect(summary).toContain(`<li>Policy: <code>${baseConfig.promptPath}</code></li>`);
    expect(summary).toMatch(/<li>Prompt hash: <code>sha256:[0-9a-f]{16}<\/code><\/li>/);
    expect(summary).toContain('<h3>Planned</h3>');
    expect(summary).toContain(`<tr><td>${issueLink(5)}</td><td>Crash when &#60;b&#62;saving&#60;/b&#62; &#38; loading</td><td>labels: +bug</td></tr>`);
    expect(summary).toContain('Discovered 1 and processed 1: 1 triaged, 0 deferred and 0 failed.');
    expect(summary).not.toContain('Not finished');
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('uses the built-in policy without a warning when the repository has no policy file', async () => {
    await withArtifactsDir(async () => {
      const gh = createGitHub();

      await run({ ...baseConfig, promptPath: '.github/AutoTriage.prompt', issueNumbers: [5] }, { gh });

      expect(gh.hasFile).toHaveBeenCalledWith('.github/AutoTriage.prompt');
      expect(readJobSummary()).toContain('<li>Policy: the built-in label-only policy, because no policy file was found</li>');
      expect(core.warning).not.toHaveBeenCalled();
      expect(processIssueMock).toHaveBeenCalled();
    });
  });

  it('warns when the repository has a policy file that the workspace lacks, as without actions/checkout', async () => {
    await withArtifactsDir(async () => {
      const gh = createGitHub();
      gh.hasFile.mockResolvedValue(true);

      await run({ ...baseConfig, promptPath: '.github/AutoTriage.prompt', issueNumbers: [5] }, { gh });

      expect(core.warning).toHaveBeenCalledWith("This run used the built-in label-only policy, because the repository has .github/AutoTriage.prompt but the workspace doesn't. Add actions/checkout before AutoTriage.");
      expect(core.setFailed).not.toHaveBeenCalled();
      expect(processIssueMock).toHaveBeenCalled();
    });
  });

  it('fails without triaging when a custom prompt-path is missing', async () => {
    const gh = createGitHub();

    await run({ ...baseConfig, promptPath: '.github/missing.prompt', issueNumbers: [5] }, { gh });

    expect(core.setFailed).toHaveBeenCalledWith("Triage didn't start: prompt-path '.github/missing.prompt' isn't in the workspace. Check the path, and that the job runs actions/checkout before AutoTriage.");
    expect(processIssueMock).not.toHaveBeenCalled();
    expect(gh.hasFile).not.toHaveBeenCalled();
  });

  it('hands every item the one system prompt, and writes it and the run summary as artifacts', async () => {
    const stats = createStats();
    fs.writeFileSync(path.join(artifactsRoot, 'README.md'), '# Demo project');

    await run({ ...baseConfig, issueNumbers: [5, 6] }, { stats });

    const artifacts = path.join(artifactsRoot, 'artifacts');
    expect(fs.readdirSync(artifacts).sort()).toEqual(['prompt-system.md', 'run-summary.json']);
    const systemPrompt = fs.readFileSync(path.join(artifacts, 'prompt-system.md'), 'utf8');
    expect(systemPrompt).toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY ===');
    expect(systemPrompt).toContain('=== SECTION: PROJECT README (MARKDOWN) ===\n# Demo project');
    expect(processIssueMock.mock.calls.map(([, options]) => options.systemPrompt)).toEqual([systemPrompt, systemPrompt]);
    const summary = JSON.parse(fs.readFileSync(path.join(artifacts, 'run-summary.json'), 'utf8'));
    expect(summary).toMatchObject({ schemaVersion: 5, funnel: { processed: 2, triaged: 2 }, items: [{ number: 5, outcome: 'triaged' }, { number: 6, outcome: 'triaged' }] });
    expect(summary.promptHash).toMatch(/^sha256:[0-9a-f]{16}$/);
  });
});
