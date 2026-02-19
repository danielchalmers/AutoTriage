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

  it('includes review comments merged into timeline for pull requests', async () => {
    const timelineData = [
      { event: 'commented', body: 'Issue comment', actor: { login: 'alice' }, created_at: '2024-01-01T01:00:00Z' },
      { event: 'reviewed', state: 'CHANGES_REQUESTED', body: 'Needs work', submitted_at: '2024-01-01T03:00:00Z', created_at: '2024-01-01T03:00:00Z' },
    ];
    const reviewCommentsData = [
      {
        id: 101,
        url: 'https://api.github.com/repos/o/r/pulls/comments/101',
        user: { login: 'reviewer' },
        body: 'This line needs fixing',
        path: 'src/main.ts',
        created_at: '2024-01-01T02:00:00Z',
        updated_at: '2024-01-01T02:00:00Z',
        diff_hunk: '@@ -1,3 +1,4 @@\n+import foo from "bar";',
      },
    ];

    mocks.paginate
      .mockResolvedValueOnce(timelineData)
      .mockResolvedValueOnce(reviewCommentsData);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { filtered } = await client.listTimelineEvents(10, 50, true);

    // All 3 events should be present
    expect(filtered).toHaveLength(3);

    // Should be sorted chronologically
    expect(filtered[0].event).toBe('commented');
    expect(filtered[1].event).toBe('review_commented');
    expect(filtered[2].event).toBe('reviewed');

    // Review comment should have body and path but no diff_hunk
    const reviewComment = filtered[1];
    expect(reviewComment.body).toBe('This line needs fixing');
    expect(reviewComment.path).toBe('src/main.ts');
    expect(reviewComment.actor).toBe('reviewer');
    expect((reviewComment as any).diff_hunk).toBeUndefined();

    // API calls: 1 for timeline + 1 for review comments
    expect(client.getApiCallCount()).toBe(2);
  });

  it('does not fetch review comments for plain issues', async () => {
    const timelineData = [
      { event: 'commented', body: 'A comment', actor: { login: 'alice' }, created_at: '2024-01-01T01:00:00Z' },
    ];

    mocks.paginate.mockResolvedValueOnce(timelineData);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { filtered } = await client.listTimelineEvents(10, 50, false);

    expect(filtered).toHaveLength(1);
    expect(filtered[0].event).toBe('commented');
    // Only 1 paginate call (timeline only)
    expect(mocks.paginate).toHaveBeenCalledTimes(1);
    expect(client.getApiCallCount()).toBe(1);
  });
});
