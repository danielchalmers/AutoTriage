import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOctokit: vi.fn(),
  issuesGet: vi.fn(),
  pullsListFiles: vi.fn(),
  pullsListReviewComments: vi.fn(),
  paginate: vi.fn(),
  issuesListForRepo: vi.fn(),
  issuesListLabelsForRepo: vi.fn(),
  issuesAddLabels: vi.fn(),
  issuesRemoveLabel: vi.fn(),
  issuesCreateComment: vi.fn(),
  issuesUpdate: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOctokit.mockReturnValue({
    rest: {
      issues: {
        get: mocks.issuesGet,
        listForRepo: mocks.issuesListForRepo,
        listLabelsForRepo: mocks.issuesListLabelsForRepo,
        addLabels: mocks.issuesAddLabels,
        removeLabel: mocks.issuesRemoveLabel,
        createComment: mocks.issuesCreateComment,
        update: mocks.issuesUpdate,
      },
      pulls: { listFiles: mocks.pullsListFiles, listReviewComments: mocks.pullsListReviewComments },
    },
    paginate: mocks.paginate,
  });
});

describe('GitHubClient.getIssue', () => {
  it('maps the REST issue payload into the metadata sent to the model', async () => {
    mocks.issuesGet.mockResolvedValue({
      data: {
        ...baseIssuePayload(7),
        state: 'closed',
        state_reason: 'completed',
        milestone: { title: 'v2.0' },
        closed_at: '2024-01-03T00:00:00Z',
        labels: ['legacy-string-label', { name: 'bug' }],
      },
    });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.getIssue(7)).toEqual({
      title: 'Sample title',
      state: 'closed',
      state_reason: 'completed',
      type: 'issue',
      number: 7,
      author: 'octocat',
      user_type: 'User',
      author_association: 'CONTRIBUTOR',
      draft: false,
      locked: false,
      milestone: 'v2.0',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
      closed_at: '2024-01-03T00:00:00Z',
      comments: 3,
      reactions: 2,
      labels: ['legacy-string-label', 'bug'],
      assignees: ['maintainer'],
      body: 'Body',
    });
    expect(mocks.issuesGet).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 7 });
  });

  it('fills safe defaults for a sparse payload', async () => {
    mocks.issuesGet.mockResolvedValue({
      data: { number: 8, title: 'Ghost', state: 'open', assignee: { login: 'solo' } },
    });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.getIssue(8)).toMatchObject({
      author: 'unknown',
      user_type: 'unknown',
      state_reason: null,
      milestone: null,
      closed_at: null,
      comments: 0,
      reactions: 0,
      labels: [],
      assignees: ['solo'],
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

describe('GitHubClient listing', () => {
  it('lists open issues most recently updated first', async () => {
    mocks.paginate.mockResolvedValue([baseIssuePayload(1), { ...baseIssuePayload(2), pull_request: {} }]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const issues = await client.listOpenIssues();

    expect(issues.map(issue => [issue.number, issue.type])).toEqual([[1, 'issue'], [2, 'pull request']]);
    expect(mocks.paginate).toHaveBeenCalledWith(mocks.issuesListForRepo, expect.objectContaining({
      state: 'open',
      sort: 'updated',
      direction: 'desc',
    }));
  });

  it.each([
    [0, 1],
    [50, 50],
    [500, 100],
  ])('requests a single page of recently closed issues for limit %i (per_page %i)', async (limit, perPage) => {
    mocks.issuesListForRepo.mockResolvedValue({ data: [baseIssuePayload(3)] });

    const client = new GitHubClient('token', 'owner', 'repo');
    const issues = await client.listRecentlyClosedIssues(limit);

    expect(issues.map(issue => issue.number)).toEqual([3]);
    expect(mocks.issuesListForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed', per_page: perPage, page: 1 }));
  });

  it('keeps named repository labels and normalizes blank descriptions to null', async () => {
    mocks.paginate.mockResolvedValue([
      { name: 'bug', description: 'Something is broken' },
      { name: 'question', description: '   ' },
      { name: 'wontfix' },
      { name: '' },
      { description: 'nameless' },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.listRepoLabels()).toEqual([
      { name: 'bug', description: 'Something is broken' },
      { name: 'question', description: null },
      { name: 'wontfix', description: null },
    ]);
  });
});

describe('GitHubClient.listTimelineEvents', () => {
  const actor = { login: 'octocat', type: 'User' };
  const at = (day: number) => `2024-01-${String(day).padStart(2, '0')}T00:00:00Z`;

  it('keeps the fields that matter for each event type and drops notification noise', async () => {
    mocks.paginate.mockResolvedValueOnce([
      { event: 'committed', sha: 'abc123', author: { login: 'dev' }, message: 'Fix it', created_at: at(1) },
      { event: 'renamed', actor, rename: { from: 'Old', to: 'New' }, created_at: at(2) },
      { event: 'assigned', actor, assignee: { login: 'dev' }, assigner: { login: 'lead' }, created_at: at(3) },
      { event: 'milestoned', actor, milestone: { title: 'v2' }, created_at: at(4) },
      { event: 'review_requested', actor, requested_team: { name: 'core' }, created_at: at(5) },
      { event: 'closed', actor, state_reason: 'not_planned', created_at: at(6) },
      { event: 'reopened', actor, created_at: at(7) },
      { event: 'reviewed', actor, state: 'approved', body: 'LGTM', submitted_at: at(8), created_at: at(8) },
      { event: 'merged', actor, created_at: at(9) },
      { event: 'mentioned', actor, created_at: at(10) },
      { event: 'subscribed', actor, created_at: at(10) },
      { event: 'unsubscribed', actor, created_at: at(10) },
      { event: 'pinned', actor, created_at: at(11) },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { raw, filtered } = await client.listTimelineEvents(42, 100);

    expect(raw).toHaveLength(13);
    expect(filtered).toEqual([
      expect.objectContaining({ event: 'committed', sha: 'abc123', author: 'dev', message: 'Fix it' }),
      expect.objectContaining({ event: 'renamed', from: 'Old', to: 'New' }),
      expect.objectContaining({ event: 'assigned', assignee: 'dev', assigner: 'lead' }),
      expect.objectContaining({ event: 'milestoned', milestone: 'v2' }),
      expect.objectContaining({ event: 'review_requested', requested_reviewer: 'core' }),
      expect.objectContaining({ event: 'closed', state: 'closed', state_reason: 'not_planned' }),
      expect.objectContaining({ event: 'reopened', state: 'open' }),
      expect.objectContaining({ event: 'reviewed', state: 'approved', body: 'LGTM', submitted_at: at(8) }),
      expect.objectContaining({ event: 'merged', merged: true }),
      expect.objectContaining({ event: 'pinned', actor: 'octocat' }),
    ]);
  });

  it('keeps only the newest events up to the limit and sorts undated events last', async () => {
    mocks.paginate.mockResolvedValueOnce([
      { event: 'commented', body: 'undated' },
      { event: 'commented', body: 'third', created_at: at(3) },
      { event: 'commented', body: 'first', created_at: at(1) },
      { event: 'commented', body: 'second', created_at: at(2) },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { filtered } = await client.listTimelineEvents(42, 3);

    expect(filtered.map(event => event.body)).toEqual(['second', 'third', 'undated']);
  });

  it('includes review comments for pull requests and sorts chronologically', async () => {
    mocks.paginate
      .mockResolvedValueOnce([
        { event: 'commented', body: 'Issue timeline comment', created_at: '2024-01-01T01:00:00Z' },
      ])
      .mockResolvedValueOnce([
        {
          user: { login: 'reviewer', type: 'User' },
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
        actor_type: 'User',
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

  it('carries the actor account type so bot activity is distinguishable from human activity', async () => {
    mocks.paginate.mockResolvedValueOnce([
      {
        event: 'labeled',
        actor: { login: 'triage-bot[bot]', type: 'Bot' },
        label: { name: 'stale' },
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        event: 'commented',
        actor: { login: 'octocat', type: 'User' },
        author_association: 'CONTRIBUTOR',
        body: 'Still happening',
        created_at: '2024-01-02T00:00:00Z',
      },
      { event: 'closed', created_at: '2024-01-03T00:00:00Z' },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { filtered } = await client.listTimelineEvents(42, 10, false);

    expect(filtered).toEqual([
      expect.objectContaining({ event: 'labeled', actor: 'triage-bot[bot]', actor_type: 'Bot' }),
      expect.objectContaining({ event: 'commented', actor: 'octocat', actor_type: 'User' }),
      expect.objectContaining({ event: 'closed', actor_type: undefined }),
    ]);
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

describe('GitHubClient writes', () => {
  it('skips the API call when there are no labels to add', async () => {
    const client = new GitHubClient('token', 'owner', 'repo');

    await client.addLabels(1, []);
    await client.addLabels(1, ['bug']);

    expect(mocks.issuesAddLabels).toHaveBeenCalledOnce();
    expect(mocks.issuesAddLabels).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 1, labels: ['bug'] });
    expect(client.getApiCallCount()).toBe(1);
  });

  it.each<[string, Parameters<GitHubClient['updateIssueState']>, object]>([
    ['clears the reason when reopening', [9, 'open'], { state: 'open', state_reason: null }],
    ['passes an explicit close reason', [9, 'closed', 'completed'], { state: 'closed', state_reason: 'completed' }],
    ['defaults a close without a reason to not_planned', [9, 'closed'], { state: 'closed', state_reason: 'not_planned' }],
  ])('updateIssueState %s', async (_label, args, expected) => {
    const client = new GitHubClient('token', 'owner', 'repo');

    await client.updateIssueState(...args);

    expect(mocks.issuesUpdate).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, ...expected });
  });

  it('sends title, comment, and label removal requests for the target item', async () => {
    const client = new GitHubClient('token', 'owner', 'repo');

    await client.updateTitle(9, 'Better title');
    await client.createComment(9, 'Hello');
    await client.removeLabel(9, 'needs info');

    expect(mocks.issuesUpdate).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, title: 'Better title' });
    expect(mocks.issuesCreateComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, body: 'Hello' });
    expect(mocks.issuesRemoveLabel).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, name: 'needs info' });
    expect(client.getApiCallCount()).toBe(3);
  });
});

describe('GitHubClient.lastUpdated', () => {
  it('returns the later of the issue update time and the newest timeline event', () => {
    const client = new GitHubClient('token', 'owner', 'repo');
    const issue = { updated_at: '2024-01-02T00:00:00Z' } as any;

    expect(client.lastUpdated(issue, [{ event: 'commented', created_at: '2024-01-05T00:00:00Z' }, { event: 'labeled' }]))
      .toBe(Date.parse('2024-01-05T00:00:00Z'));
    expect(client.lastUpdated(issue, [{ event: 'commented', created_at: '2024-01-01T00:00:00Z' }]))
      .toBe(Date.parse('2024-01-02T00:00:00Z'));
    expect(client.lastUpdated({} as any, [])).toBe(0);
  });
});
