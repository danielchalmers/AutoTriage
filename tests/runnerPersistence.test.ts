import { describe, expect, it, vi } from 'vitest';

const processIssueMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ triageUsed: true, fastRunUsed: true })
);
const saveDatabaseMock = vi.hoisted(() => vi.fn());

vi.mock('../src/issueProcessor', async () => {
  const actual = await vi.importActual<typeof import('../src/issueProcessor')>('../src/issueProcessor');
  return {
    ...actual,
    processIssue: processIssueMock,
  };
});

vi.mock('../src/storage', async () => {
  const actual = await vi.importActual<typeof import('../src/storage')>('../src/storage');
  return {
    ...actual,
    saveDatabase: saveDatabaseMock,
  };
});

import { runAutoTriage } from '../src/runner';
import type { Config } from '../src/config';
import type { Issue } from '../src/github';

const baseConfig: Config = {
  owner: 'owner',
  repo: 'repo',
  token: 'token',
  geminiApiKey: 'key',
  dryRun: false,
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
  maxProRuns: 1,
  maxFastRuns: 100,
  extended: false,
  strictMode: false,
};

function makeIssue(number: number, updatedAt: string): Issue {
  return {
    title: 'Sample',
    state: 'open',
    type: 'issue',
    number,
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
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}

describe('runAutoTriage database persistence', () => {
  it('saves the database before stopping at the max pro run limit', async () => {
    saveDatabaseMock.mockClear();
    processIssueMock.mockClear();

    const gh = {
      listRepoLabels: vi.fn().mockResolvedValue([]),
      listOpenIssues: vi.fn().mockResolvedValue([makeIssue(5, '2024-04-05T00:00:00Z')]),
      listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
      getIssue: vi.fn().mockResolvedValue(makeIssue(5, '2024-04-05T00:00:00Z')),
      getApiCallCount: vi.fn().mockReturnValue(0),
    };
    const gemini = {
      createCache: vi.fn().mockResolvedValue({ name: 'cachedContents/fast', tokenCount: 10 }),
      deleteCache: vi.fn().mockResolvedValue(undefined),
    };
    const stats = {
      trackCacheCreate: vi.fn(),
      incrementTriaged: vi.fn(),
      incrementSkipped: vi.fn(),
      incrementFailed: vi.fn(),
      incrementGithubApiCalls: vi.fn(),
      printSummary: vi.fn(),
      getFailed: vi.fn().mockReturnValue(0),
    };

    await runAutoTriage({
      cfg: baseConfig,
      db: {},
      gh: gh as any,
      gemini: gemini as any,
      stats: stats as any,
    });

    expect(processIssueMock).toHaveBeenCalledOnce();
    expect(saveDatabaseMock).toHaveBeenCalledOnce();
    expect(saveDatabaseMock.mock.invocationCallOrder[0]).toBeLessThan(stats.printSummary.mock.invocationCallOrder[0]);
  });
});
