import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processIssueMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ triageUsed: true, fastRunUsed: true })
);
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
import { GeminiResponseError } from '../src/gemini';
import { listTargets, runAutoTriage } from '../src/runner';
import { makeClosedIssue, makeConfig, makeDb, makeIssue, withTempDir } from './fixtures';

const baseConfig = makeConfig();

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
    processIssueMock.mockResolvedValue({ triageUsed: true, fastRunUsed: true });
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
    return {
      trackCacheCreate: vi.fn(),
      incrementTriaged: vi.fn(),
      incrementSkipped: vi.fn(),
      incrementFailed: vi.fn(),
      incrementGithubApiCalls: vi.fn(),
      printSummary: vi.fn(),
      getFailed: vi.fn().mockReturnValue(0),
      setDiscovered: vi.fn(),
      setCapReached: vi.fn(),
      setRunConfig: vi.fn(),
      setPromptHashes: vi.fn(),
      recordItem: vi.fn(),
      beginPass: vi.fn(),
      getCurrentPass: vi.fn().mockReturnValue(null),
      toJSON: vi.fn().mockReturnValue({}),
    };
  }

  function createGemini() {
    return {
      createCache: vi.fn(),
      deleteCache: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createGitHub() {
    return {
      listRepoLabels: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi.fn().mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z')]),
      listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn().mockResolvedValue(makeIssue(5, '2024-04-05T00:00:00Z')),
      getApiCallCount: vi.fn().mockReturnValue(0),
    };
  }

  it('creates caches for backlog auto-discovery runs', async () => {
    const gh = createGitHub();
    const gemini = createGemini();
    gemini.createCache
      .mockResolvedValueOnce({ name: 'cachedContents/fast', tokenCount: 10 })
      .mockResolvedValueOnce({ name: 'cachedContents/pro', tokenCount: 20 });
    const stats = createStats();

    await runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: gh as any, gemini: gemini as any, stats: stats as any });

    expect(gemini.createCache).toHaveBeenCalledTimes(2);
    expect(processIssueMock).toHaveBeenCalledOnce();
    const options = processIssueMock.mock.calls[0]![1];
    expect(options.autoDiscover).toBe(true);
    expect(options.cacheInfos.get('fast')?.name).toBe('cachedContents/fast');
    expect(options.cacheInfos.get('pro')?.name).toBe('cachedContents/pro');
    expect(gemini.deleteCache).toHaveBeenCalledWith('cachedContents/fast');
    expect(gemini.deleteCache).toHaveBeenCalledWith('cachedContents/pro');
  });

  it('skips caches for explicit target runs', async () => {
    const gh = createGitHub();
    const gemini = createGemini();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: gh as any,
      gemini: gemini as any,
      stats: stats as any,
    });

    expect(gemini.createCache).not.toHaveBeenCalled();
    expect(processIssueMock).toHaveBeenCalledOnce();
    const options = processIssueMock.mock.calls[0]![1];
    expect(options.autoDiscover).toBe(false);
    expect(options.cacheInfos.size).toBe(0);
  });

  it('falls back to uncached processing when cache creation is unavailable', async () => {
    const gh = createGitHub();
    const gemini = createGemini();
    gemini.createCache.mockRejectedValue(new Error('Caching is not supported for this account'));
    const stats = createStats();

    await expect(
      runAutoTriage({ cfg: baseConfig, db: makeDb(), gh: gh as any, gemini: gemini as any, stats: stats as any })
    ).resolves.toBeUndefined();

    expect(gemini.createCache).toHaveBeenCalledTimes(2);
    expect(processIssueMock).toHaveBeenCalledOnce();
    const options = processIssueMock.mock.calls[0]![1];
    expect(options.autoDiscover).toBe(true);
    expect(options.cacheInfos.size).toBe(0);
    expect(gemini.deleteCache).not.toHaveBeenCalled();
  });

  it('saves the database after processing the item that reaches max-pro-runs', async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json');
      const gh = createGitHub();
      const gemini = createGemini();
      const stats = createStats();

      await runAutoTriage({
        cfg: { ...baseConfig, dbPath, dryRun: false, issueNumbers: [5], maxProRuns: 1 },
        db: makeDb({ '5': { lastTriaged: '2024-04-01T00:00:00Z' } }),
        gh: gh as any,
        gemini: gemini as any,
        stats: stats as any,
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
    const gemini = createGemini();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxFastRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      gemini: gemini as any,
      stats: stats as any,
    });

    expect(logSpy).toHaveBeenCalledWith('⏳ Max fast runs (1) reached with 2 item(s) remaining');
    expect(stats.setCapReached).toHaveBeenCalledWith('fast');
    expect(processIssueMock).toHaveBeenCalledOnce();
  });

  it('continues past an unexpected per-item error and processes the rest of the backlog', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gh = createGitHub();
    const gemini = createGemini();
    const stats = createStats();
    processIssueMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ triageUsed: true, fastRunUsed: true });

    try {
      await runAutoTriage({
        cfg: { ...baseConfig, issueNumbers: [5, 6] },
        db: makeDb(),
        gh: gh as any,
        gemini: gemini as any,
        stats: stats as any,
      });

      expect(processIssueMock).toHaveBeenCalledTimes(2);
      expect(stats.incrementFailed).toHaveBeenCalledOnce();
      expect(stats.recordItem).toHaveBeenCalledWith({ issueNumber: 5, outcome: 'failed', escalatedToPro: false });
      expect(stats.incrementTriaged).toHaveBeenCalledOnce();
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
    const gemini = createGemini();
    const stats = createStats();
    processIssueMock.mockRejectedValue(new Error('socket hang up'));

    try {
      await runAutoTriage({
        cfg: { ...baseConfig, issueNumbers: [5, 6, 7, 8] },
        db: makeDb(),
        gh: gh as any,
        gemini: gemini as any,
        stats: stats as any,
      });

      expect(processIssueMock).toHaveBeenCalledTimes(3);
      expect(stats.incrementFailed).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith('Analysis failed 3 consecutive times; stopping further processing.');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs remaining backlog items when max pro runs is reached', async () => {
    const gh = createGitHub();
    const gemini = createGemini();
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      gemini: gemini as any,
      stats: stats as any,
    });

    expect(logSpy).toHaveBeenCalledWith('⏳ Max pro runs (1) reached with 2 item(s) remaining');
    expect(stats.setCapReached).toHaveBeenCalledWith('pro');
    expect(processIssueMock).toHaveBeenCalledOnce();
  });

  it('does not spend the pro budget on items the fast pass skipped', async () => {
    processIssueMock
      .mockResolvedValueOnce({ triageUsed: false, fastRunUsed: true })
      .mockResolvedValueOnce({ triageUsed: false, fastRunUsed: true })
      .mockResolvedValueOnce({ triageUsed: true, fastRunUsed: true });
    const stats = createStats();

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5, 6, 7], maxProRuns: 1 },
      db: makeDb(),
      gh: createGitHub() as any,
      gemini: createGemini() as any,
      stats: stats as any,
    });

    expect(processIssueMock).toHaveBeenCalledTimes(3);
    expect(stats.incrementSkipped).toHaveBeenCalledTimes(2);
    expect(stats.incrementTriaged).toHaveBeenCalledOnce();
  });

  it('ignores the fast-run cap and creates only the pro cache when the fast pass is disabled', async () => {
    processIssueMock.mockResolvedValue({ triageUsed: true, fastRunUsed: false });
    const gh = createGitHub();
    gh.listOpenIssues.mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z'), makeIssue(6, '2024-04-06T00:00:00Z')]);
    const gemini = createGemini();
    gemini.createCache.mockResolvedValue({ name: 'cachedContents/pro', tokenCount: 20 });

    await runAutoTriage({
      cfg: { ...baseConfig, skipFastPass: true, modelFast: '', maxFastRuns: 1 },
      db: makeDb(),
      gh: gh as any,
      gemini: gemini as any,
      stats: createStats() as any,
    });

    expect(gemini.createCache).toHaveBeenCalledOnce();
    expect(gemini.createCache).toHaveBeenCalledWith('pro-model', expect.any(String), 'autotriage-pro-owner/repo');
    expect(processIssueMock).toHaveBeenCalledTimes(2);
    expect(processIssueMock.mock.calls[0]![1].systemPromptFast).toBe('');
  });

  it('resets the consecutive-failure breaker after a success', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('socket hang up');
    const success = { triageUsed: true, fastRunUsed: true };
    processIssueMock
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(success)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(success);

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [1, 2, 3, 4, 5, 6] },
      db: makeDb(),
      gh: createGitHub() as any,
      gemini: createGemini() as any,
      stats: createStats() as any,
    });

    expect(processIssueMock).toHaveBeenCalledTimes(6);
    expect(warnSpy.mock.calls.filter(([message]) => String(message).includes('unexpected error'))).toHaveLength(4);
  });

  it('logs model errors without a stack and attributes the failure to the pass in flight', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new GeminiResponseError('Unable to parse JSON from Gemini response'));
    const stats = createStats();
    stats.getCurrentPass.mockReturnValue('pro');

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      gemini: createGemini() as any,
      stats: stats as any,
    });

    expect(warnSpy).toHaveBeenCalledWith('#5: Unable to parse JSON from Gemini response');
    expect(stats.recordItem).toHaveBeenCalledWith({ issueNumber: 5, outcome: 'failed', escalatedToPro: true, failedPass: 'pro' });
  });

  it('fails the job in strict mode when any item failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new Error('socket hang up'));
    const stats = createStats();
    stats.getFailed.mockReturnValue(1);

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5], strictMode: true },
      db: makeDb(),
      gh: createGitHub() as any,
      gemini: createGemini() as any,
      stats: stats as any,
    });

    expect(core.setFailed).toHaveBeenCalledWith('Strict mode enabled: 1 run(s) had errors.');
  });

  it('does not fail the job outside strict mode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    processIssueMock.mockRejectedValueOnce(new Error('socket hang up'));
    const stats = createStats();
    stats.getFailed.mockReturnValue(1);

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      gemini: createGemini() as any,
      stats: stats as any,
    });

    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it('writes the system prompts and run summary artifacts', async () => {
    const stats = createStats();
    stats.toJSON.mockReturnValue({ schemaVersion: 2 });

    await runAutoTriage({
      cfg: { ...baseConfig, issueNumbers: [5] },
      db: makeDb(),
      gh: createGitHub() as any,
      gemini: createGemini() as any,
      stats: stats as any,
    });

    const artifacts = path.join(artifactsRoot, 'artifacts');
    expect(fs.readdirSync(artifacts).sort()).toEqual(['0-run-summary.json', 'prompt-system-fast.md', 'prompt-system.md']);
    expect(JSON.parse(fs.readFileSync(path.join(artifacts, '0-run-summary.json'), 'utf8'))).toEqual({ schemaVersion: 2 });
    expect(fs.readFileSync(path.join(artifacts, 'prompt-system.md'), 'utf8')).toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY ===');
  });
});
