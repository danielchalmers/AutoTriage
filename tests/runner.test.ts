import { describe, expect, it, vi } from 'vitest';
import { listTargets } from '../src/runner';
import { Issue } from '../src/github';
import { Config, TriageDb } from '../src/storage';

const baseConfig: Config = {
  owner: 'owner',
  repo: 'repo',
  token: 'token',
  geminiApiKey: 'key',
  dryRun: true,
  thinkingBudget: -1,
  promptPath: '.github/AutoTriage.prompt',
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
  contextCaching: false,
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

describe('listTargets', () => {
  it('uses explicit issue inputs before any other source', async () => {
    const gh = {
      listOpenIssues: vi.fn(),
      listRecentlyClosedIssues: vi.fn(),
    };

    const result = await listTargets({
      cfg: { ...baseConfig, issueNumbers: [3, 5] },
      db: {},
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
      db: {},
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
    const db: TriageDb = {
      '4': { lastTriaged: '2024-04-02T00:00:00Z' },
    };

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
    const db: TriageDb = {
      '4': { lastTriaged: '2024-04-01T00:00:00Z' },
      '5': { lastTriaged: '2024-04-02T00:00:00Z' },
    };

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
