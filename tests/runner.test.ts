import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processIssueMock = vi.hoisted(() => vi.fn());
const githubContextMock = vi.hoisted(() => ({
  payload: {},
}));

vi.mock('@actions/github', () => ({
  context: githubContextMock,
}));

// setFailed would otherwise print ::error:: and set process.exitCode for the test worker.
vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  setFailed: vi.fn(),
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
import { ModelError } from '../src/llm/chat';
import { PassError } from '../src/issueProcessor';
import { listTargets, runAutoTriage } from '../src/runner';
import { ItemRecord, RunStatistics } from '../src/stats';
import { bothPasses, makeClosedIssue, makeConfig, makeDb, makeIssue, withTempDir } from './fixtures';

const baseConfig = makeConfig();

// The records processIssue returns, for an item whose fast pass ran.
const fastPlan = { kinds: ['add_labels'], labels: ['+bug'] };
function triaged(issueNumber: number, overrides: Partial<ItemRecord> = {}): ItemRecord {
  return { issueNumber, type: 'issue', outcome: 'triaged', escalatedToPro: true, fastPlan, proPlan: fastPlan, agreement: 'identical', ...overrides };
}
function skipped(issueNumber: number): ItemRecord {
  return { issueNumber, type: 'issue', outcome: 'skipped', escalatedToPro: false, fastPlan: { kinds: [], labels: [] }, agreement: 'fast-noop' };
}
function deferred(issueNumber: number): ItemRecord {
  return triaged(issueNumber, { outcome: 'deferred' });
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

  beforeEach(() => {
    vi.clearAllMocks();
    githubContextMock.payload = {};
    processIssueMock.mockReset();
    processIssueMock.mockImplementation(async (_deps, { issue }) => triaged(issue.number));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Run artifacts (system prompts, run summary) land in a throwaway directory instead of the repository root.
    artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-runner-'));
    vi.spyOn(process, 'cwd').mockReturnValue(artifactsRoot);
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
    };
  }

  it('tells each item whether it came from backlog auto-discovery', async () => {
    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: createGitHub() as any, models: bothPasses(createModel()), stats: createStats() });
    await runAutoTriage({ cfg: { ...baseConfig, issueNumbers: [5] }, db: makeDb(), gh: createGitHub() as any, models: bothPasses(createModel()), stats: createStats() });

    expect(processIssueMock.mock.calls.map(([, options]) => options.autoDiscover)).toEqual([true, false]);
  });

  it('logs an explicit target list once', async () => {
    await runAutoTriage({ cfg: { ...baseConfig, issueNumbers: [5, 6] }, db: makeDb(), gh: createGitHub() as any, models: bothPasses(createModel()), stats: createStats() });

    const targetLines = (logSpy.mock.calls as unknown[][]).map((call) => String(call[0])).filter((line) => line.startsWith('▶️'));
    expect(targetLines).toEqual(['▶️ Triaging 2 item(s): #5, #6']);
  });

  it('logs the size of an auto-discovered backlog instead of every number', async () => {
    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: createGitHub() as any, models: bothPasses(createModel()), stats: createStats() });

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
        models: bothPasses(model),
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

  it('logs remaining backlog items when max fast runs is reached', async () => {
    const gh = createGitHub();
    gh.getIssue
      .mockResolvedValueOnce(makeIssue(5, '2024-04-05T00:00:00Z'))
      .mockResolvedValueOnce(makeIssue(6, '2024-04-06T00:00:00Z'));
    const model = createModel();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxFastRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      models: bothPasses(model),
      stats,
    });

    expect(logSpy).toHaveBeenCalledWith('⏳ Max fast runs (1) reached with 2 item(s) remaining');
    expect(summaryOf(stats).funnel.capReached).toBe('fast');
    expect(processIssueMock).toHaveBeenCalledOnce();
  });

  it('continues past an unexpected per-item error and processes the rest of the backlog', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gh = createGitHub();
    const model = createModel();
    const stats = createStats();
    processIssueMock.mockRejectedValueOnce(new Error('socket hang up'));

    try {
      await runAutoTriage({
        cfg: { ...baseConfig, issueNumbers: [5, 6] },
        db: makeDb(),
        gh: gh as any,
        models: bothPasses(model),
        stats,
      });

      expect(processIssueMock).toHaveBeenCalledTimes(2);
      expect(summaryOf(stats).items).toEqual([
        expect.objectContaining({ number: 5, outcome: 'failed', escalatedToPro: false, failedPass: undefined, failureReason: 'other' }),
        expect.objectContaining({ number: 6, outcome: 'triaged' }),
      ]);
      expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, failed: 1 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('#5: unexpected error: '));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('socket hang up'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('stops processing after three consecutive unexpected failures', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gh = createGitHub();
    const model = createModel();
    const stats = createStats();
    processIssueMock.mockRejectedValue(new Error('socket hang up'));

    try {
      await runAutoTriage({
        cfg: { ...baseConfig, issueNumbers: [5, 6, 7, 8] },
        db: makeDb(),
        gh: gh as any,
        models: bothPasses(model),
        stats,
      });

      expect(processIssueMock).toHaveBeenCalledTimes(3);
      expect(summaryOf(stats).funnel).toMatchObject({ processed: 3, failed: 3 });
      expect(errorSpy).toHaveBeenCalledWith('Analysis failed 3 consecutive times; stopping further processing.');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs remaining backlog items when max pro runs is reached', async () => {
    const gh = createGitHub();
    const model = createModel();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      models: bothPasses(model),
      stats,
    });

    expect(logSpy).toHaveBeenCalledWith('⏳ Max pro runs (1) reached with 2 item(s) remaining');
    expect(summaryOf(stats).funnel.capReached).toBe('pro');
    expect(processIssueMock).toHaveBeenCalledOnce();
  });

  it('does not spend the pro budget on items the fast pass skipped', async () => {
    processIssueMock
      .mockResolvedValueOnce(skipped(5))
      .mockResolvedValueOnce(skipped(6));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 1 },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(processIssueMock).toHaveBeenCalledTimes(3);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 3, triaged: 1, skipped: 2, escalatedToPro: 1 });
  });

  it('counts a deferred item apart from triaged ones while spending the pro budget on it', async () => {
    processIssueMock.mockResolvedValueOnce(deferred(5));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 2 },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(summaryOf(stats).funnel).toMatchObject({ processed: 2, triaged: 1, deferred: 1, escalatedToPro: 2, capReached: 'pro' });
    expect(logSpy).toHaveBeenCalledWith('  Total: ✅ 1 triaged ⏸️ 1 deferred');
  });

  it('ignores the fast-run cap and writes no fast system prompt when the fast pass is disabled', async () => {
    processIssueMock.mockImplementation(async (_deps, { issue }) => triaged(issue.number, { fastPlan: undefined, agreement: undefined }));
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z'), makeIssue(6, '2024-04-06T00:00:00Z')]);

    await runAutoTriage({
      cfg: { ...baseConfig, skipFastPass: true, modelFast: '', maxFastRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      models: bothPasses(createModel()),
      stats: createStats(),
    });

    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(processIssueMock.mock.calls[0]![1].systemPromptFast).toBe('');
    expect(fs.readdirSync(path.join(artifactsRoot, 'artifacts')).sort()).toEqual(['prompt-system.md', 'run-summary.json']);
  });

  it('resets the consecutive-failure breaker after a success', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('socket hang up');
    processIssueMock
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(triaged(3))
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure);

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [1, 2, 3, 4, 5, 6] },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats: createStats(),
    });

    expect(processIssueMock).toHaveBeenCalledTimes(6);
    expect(warnSpy.mock.calls.filter(([message]) => String(message).includes('unexpected error'))).toHaveLength(4);
  });

  it('logs model errors without a stack and attributes the failure to the pass in flight', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new PassError('pro', new ModelError('Unable to parse JSON from the api.openai.com response')));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(warnSpy).toHaveBeenCalledWith('#5: Unable to parse JSON from the api.openai.com response');
    expect(summaryOf(stats).items).toEqual([
      expect.objectContaining({ number: 5, outcome: 'failed', escalatedToPro: true, failedPass: 'pro', failureReason: 'retryable' }),
    ]);
  });

  it('logs a model call that ran out of retries without a stack', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new PassError('fast', new ModelError('fetch failed (ECONNRESET)', 'capacity')));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(warnSpy).toHaveBeenCalledWith('#5: fetch failed (ECONNRESET)');
    expect(summaryOf(stats).items).toEqual([
      expect.objectContaining({ number: 5, outcome: 'failed', escalatedToPro: false, failedPass: 'fast', failureReason: 'capacity' }),
    ]);
  });

  it('stops the run and fails the job on a fatal model error, even outside strict mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z'), makeIssue(6, '2024-04-06T00:00:00Z')]);
    const stats = createStats();
    const printSummary = vi.spyOn(stats, 'printSummary');
    const message = 'api.openai.com returned HTTP 401: {"error":{"message":"Incorrect API key provided"}} Check OPENAI_API_KEY.';
    processIssueMock.mockRejectedValueOnce(new PassError('fast', new ModelError(message, 'fatal')));

    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: gh as any, models: bothPasses(createModel()), stats });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(core.setFailed).toHaveBeenCalledExactlyOnceWith(`Stopped the run at #5 because of a model error that every later item would hit too: ${message}`);
    expect(summaryOf(stats).items).toEqual([expect.objectContaining({ outcome: 'failed', failedPass: 'fast', failureReason: 'fatal' })]);
    // The run still reports.
    expect(printSummary).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Incorrect API key'));
  });

  it('fails the job only once in strict mode when a fatal model error stops the run', async () => {
    processIssueMock.mockRejectedValueOnce(new PassError('pro', new ModelError('x', 'fatal')));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6], strictMode: true },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(core.setFailed).toHaveBeenCalledOnce();
  });

  it('fails the job in strict mode when any item failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new Error('socket hang up'));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5], strictMode: true },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(core.setFailed).toHaveBeenCalledWith('Strict mode enabled: 1 run(s) had errors.');
  });

  it('does not fail the job outside strict mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new Error('socket hang up'));
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('writes the system prompts and run summary artifacts', async () => {
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      models: bothPasses(createModel()),
      stats,
    });

    const artifacts = path.join(artifactsRoot, 'artifacts');
    expect(fs.readdirSync(artifacts).sort()).toEqual(['prompt-system-fast.md', 'prompt-system.md', 'run-summary.json']);
    const summary = JSON.parse(fs.readFileSync(path.join(artifacts, 'run-summary.json'), 'utf8'));
    expect(summary).toMatchObject({ schemaVersion: 5, funnel: { processed: 1, triaged: 1 }, items: [{ number: 5, outcome: 'triaged' }] });
    expect(summary.promptHash).toEqual({ fast: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), pro: expect.stringMatching(/^sha256:[0-9a-f]{16}$/) });
    expect(fs.readFileSync(path.join(artifacts, 'prompt-system.md'), 'utf8')).toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY ===');
  });
});
