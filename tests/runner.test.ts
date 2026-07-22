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

vi.mock('../src/issueProcessor', async () => {
  const actual = await vi.importActual<typeof import('../src/issueProcessor')>('../src/issueProcessor');
  return {
    ...actual,
    processIssue: processIssueMock,
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listTargets, runAutoTriage } from '../src/runner';
import { Issue } from '../src/github';
import type { Config } from '../src/config';
import { TriageDb } from '../src/storage';

const baseConfig: Config = {
  owner: 'owner',
  repo: 'repo',
  token: 'token',
  geminiApiKey: 'key',
  dryRun: true,
  promptPath: 'examples/AutoTriage.prompt',
  readmePath: 'README.md',
  skipFastPass: false,
  modelFast: 'fast-model',
  modelPro: 'pro-model',
  maxFastTimelineEvents: 12,
  maxProTimelineEvents: 40,
  maxFastReadmeChars: 0,
  maxProReadmeChars: 120000,
  maxFastIssueBodyChars: 4000,
  maxProIssueBodyChars: 20000,
  maxFastTimelineTextChars: 600,
  maxProTimelineTextChars: 4000,
  maxProRuns: 20,
  maxFastRuns: 100,
  extended: false,
  strictMode: false,
};

const baseIssue: Omit<Issue, 'number' | 'updated_at' | 'created_at'> = {
  title: 'Sample',
  state: 'open',
  type: 'issue',
  author: 'octocat',
  user_type: 'User',
  draft: false,
  locked: false,
  milestone: null,
  comments: 0,
  reactions: 0,
  labels: [],
  assignees: [],
  body: null,
};

function makeIssue(number: number, updatedAt: string): Issue {
  return {
    ...baseIssue,
    number,
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}

function makeClosedIssue(number: number, closedAt: string, updatedAt: string): Issue {
  return {
    ...makeIssue(number, updatedAt),
    state: 'closed',
    closed_at: closedAt,
  };
}

function makeDb(items: TriageDb['items'] = {}): TriageDb {
  return {
    version: 2,
    items,
  };
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

describe('runAutoTriage automatic backlog caching', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    githubContextMock.payload = {};
    processIssueMock.mockResolvedValue({ triageUsed: true, fastRunUsed: true });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-runner-db-'));
    const dbPath = path.join(tempDir, 'triage-db.json');
    const gh = createGitHub();
    const gemini = createGemini();
    const stats = createStats();

    try {
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
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
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
  });
});
