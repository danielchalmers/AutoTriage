import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOctokit: vi.fn(),
  issuesGet: vi.fn(),
  pullsListFiles: vi.fn(),
  pullsListReviewComments: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  getOctokit: mocks.getOctokit,
}));

import { GitHubClient } from '../src/github';

function baseIssuePayload(number: number) {
  return {
    title: 'Sample title',
    state: 'open',
    number,
    user: { login: 'octocat', type: 'User' },
    author_association: 'CONTRIBUTOR',
    draft: false,
    locked: false,
    milestone: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    closed_at: null,
    comments: 3,
    reactions: { total_count: 2 },
    labels: [{ name: 'bug' }],
    assignees: [{ login: 'maintainer' }],
    body: 'Body',
  };
}

describe('GitHubClient.getIssue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOctokit.mockReturnValue({
      rest: {
        issues: { get: mocks.issuesGet },
        pulls: { listFiles: mocks.pullsListFiles, listReviewComments: mocks.pullsListReviewComments },
      },
      paginate: mocks.paginate,
    });
  });

  it('includes the full changed filename list for pull requests', async () => {
    mocks.issuesGet.mockResolvedValue({
      data: {
        ...baseIssuePayload(42),
        pull_request: { url: 'https://api.github.com/repos/o/r/pulls/42' },
      },
    });
    mocks.paginate.mockResolvedValue([
      { filename: 'src/github.ts' },
      { filename: 'tests/githubClient.test.ts' },
      { somethingElse: true },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const issue = await client.getIssue(42);

    expect(issue.type).toBe('pull request');
    expect(issue.changed_files).toEqual(['src/github.ts', 'tests/githubClient.test.ts']);
    expect(mocks.paginate).toHaveBeenCalledWith(
      mocks.pullsListFiles,
      expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        pull_number: 42,
        per_page: 100,
      })
    );
    expect(client.getApiCallCount()).toBe(2);
  });

  it('does not request changed filenames for issues', async () => {
    mocks.issuesGet.mockResolvedValue({ data: baseIssuePayload(7) });

    const client = new GitHubClient('token', 'owner', 'repo');
    const issue = await client.getIssue(7);

    expect(issue.type).toBe('issue');
    expect(issue.changed_files).toBeUndefined();
    expect(mocks.paginate).not.toHaveBeenCalled();
    expect(client.getApiCallCount()).toBe(1);
  });
});

describe('GitHubClient.listTimelineEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOctokit.mockReturnValue({
      rest: {
        issues: { get: mocks.issuesGet },
        pulls: { listFiles: mocks.pullsListFiles, listReviewComments: mocks.pullsListReviewComments },
      },
      paginate: mocks.paginate,
    });
  });

  it('includes review comments for pull requests and sorts chronologically', async () => {
    mocks.paginate
      .mockResolvedValueOnce([
        { event: 'commented', body: 'Issue timeline comment', created_at: '2024-01-01T01:00:00Z' },
      ])
      .mockResolvedValueOnce([
        {
          user: { login: 'reviewer' },
          author_association: 'MEMBER',
          created_at: '2024-01-01T00:30:00Z',
          updated_at: '2024-01-01T00:30:00Z',
          body: 'Inline review comment',
          path: 'src/file.ts',
        },
      ]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { filtered } = await client.listTimelineEvents(42, 10, true);

    expect(filtered).toEqual([
      expect.objectContaining({
        event: 'review_commented',
        actor: 'reviewer',
        body: 'Inline review comment',
        path: 'src/file.ts',
      }),
      expect.objectContaining({
        event: 'commented',
        body: 'Issue timeline comment',
      }),
    ]);
    expect(client.getApiCallCount()).toBe(2);
  });

  it('does not fetch review comments for issues', async () => {
    mocks.paginate.mockResolvedValueOnce([
      { event: 'commented', body: 'Issue timeline comment', created_at: '2024-01-01T01:00:00Z' },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { filtered } = await client.listTimelineEvents(42, 10, false);

    expect(filtered).toEqual([
      expect.objectContaining({
        event: 'commented',
        body: 'Issue timeline comment',
      }),
    ]);
    expect(client.getApiCallCount()).toBe(1);
  });
});
