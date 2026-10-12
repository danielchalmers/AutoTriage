import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOctokit: vi.fn(),
  issuesGet: vi.fn(),
  pullsListFiles: vi.fn(),
  pullsListReviewComments: vi.fn(),
  pullsGet: vi.fn(),
  pullsList: vi.fn(),
  paginate: vi.fn(),
  issuesListForRepo: vi.fn(),
  issuesListLabelsForRepo: vi.fn(),
  issuesAddLabels: vi.fn(),
  issuesRemoveLabel: vi.fn(),
  issuesCreateComment: vi.fn(),
  issuesUpdate: vi.fn(),
  reposGetContent: vi.fn(),
}));

vi.mock('@actions/github', () => ({
  getOctokit: mocks.getOctokit,
}));

import { ConfigurationError, classifyFailure } from '../src/failures';
import { GitHubClient } from '../src/github';
import { githubError } from './fixtures';

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
      pulls: { listFiles: mocks.pullsListFiles, listReviewComments: mocks.pullsListReviewComments, get: mocks.pullsGet, list: mocks.pullsList },
      repos: { getContent: mocks.reposGetContent },
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

  it('requests one page of the 100 most recently updated closed issues', async () => {
    mocks.issuesListForRepo.mockResolvedValue({ data: [baseIssuePayload(3)] });

    const client = new GitHubClient('token', 'owner', 'repo');
    const issues = await client.listRecentlyClosedIssues();

    expect(issues.map(issue => issue.number)).toEqual([3]);
    expect(mocks.issuesListForRepo).toHaveBeenCalledWith(expect.objectContaining({ state: 'closed', sort: 'updated', direction: 'desc', per_page: 100, page: 1 }));
    expect(mocks.paginate).not.toHaveBeenCalled();
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

describe('GitHubClient pull request lookups for a workflow_run event', () => {
  // Shaped like GitHub's pull request payload, trimmed to the fields around the ones AutoTriage reads.
  function pullPayload(number: number, overrides: Record<string, unknown> = {}) {
    return {
      number,
      state: 'open',
      draft: false,
      title: 'Fix typo',
      user: { login: 'pat', type: 'User' },
      created_at: '2026-10-11T12:00:00Z',
      updated_at: '2026-10-11T12:05:00Z',
      head: { label: 'pat:fix-typo', ref: 'fix-typo', sha: 'abc123', repo: { id: 2002, full_name: 'pat/repo' } },
      base: { label: 'owner:main', ref: 'main', sha: 'def456', repo: { id: 1001, full_name: 'owner/repo' } },
      ...overrides,
    };
  }

  it('reads one pull request', async () => {
    mocks.pullsGet.mockResolvedValue({ data: pullPayload(12, { draft: true }) });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.getPullRequest(12)).toEqual({ number: 12, state: 'open', draft: true, created_at: '2026-10-11T12:00:00Z', head_sha: 'abc123' });
    expect(mocks.pullsGet).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', pull_number: 12 });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('lists the open pull requests from an owner:branch head', async () => {
    mocks.paginate.mockResolvedValue([pullPayload(12), pullPayload(13, { head: { sha: 'f00' } })]);

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.listOpenPullRequestsByHead('pat:fix-typo')).toEqual([
      { number: 12, state: 'open', draft: false, created_at: '2026-10-11T12:00:00Z', head_sha: 'abc123' },
      { number: 13, state: 'open', draft: false, created_at: '2026-10-11T12:00:00Z', head_sha: 'f00' },
    ]);
    expect(mocks.paginate).toHaveBeenCalledWith(mocks.pullsList, { owner: 'owner', repo: 'repo', state: 'open', head: 'pat:fix-typo', per_page: 100 });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('finds when a pull request was last marked ready for review', async () => {
    mocks.paginate.mockResolvedValue([
      { event: 'ready_for_review', actor: { login: 'pat' }, created_at: '2026-10-11T12:00:00Z' },
      { event: 'convert_to_draft', actor: { login: 'pat' }, created_at: '2026-10-11T12:30:00Z' },
      { event: 'ready_for_review', actor: { login: 'pat' }, created_at: '2026-10-11T13:00:00Z' },
      { event: 'commented', actor: { login: 'pat' }, created_at: '2026-10-11T14:00:00Z' },
      { event: 'ready_for_review' },
    ]);

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.getLastReadyForReview(12)).toBe('2026-10-11T13:00:00Z');
    expect(mocks.paginate).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', { owner: 'owner', repo: 'repo', issue_number: 12, per_page: 100 });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('finds no ready-for-review time for a pull request that was never a draft', async () => {
    mocks.paginate.mockResolvedValue([{ event: 'labeled', created_at: '2026-10-11T12:00:00Z' }]);

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.getLastReadyForReview(12)).toBeUndefined();
  });
});

describe('GitHubClient repository file reads', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';

  it('lists the names of the files in the repository root at a commit', async () => {
    mocks.reposGetContent.mockResolvedValue({
      data: [
        { type: 'dir', name: '.github', path: '.github' },
        { type: 'file', name: 'LICENSE', path: 'LICENSE' },
        { type: 'file', name: 'README.md', path: 'README.md' },
        { type: 'symlink', name: 'docs', path: 'docs' },
        { type: 'file' },
      ],
    });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.listRootFiles(SHA)).toEqual(['LICENSE', 'README.md']);
    expect(mocks.reposGetContent).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', path: '', ref: SHA });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('lists the default branch on a local run, which has no commit', async () => {
    mocks.reposGetContent.mockResolvedValue({ data: [] });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.listRootFiles(undefined)).toEqual([]);
    expect(mocks.reposGetContent).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', path: '' });
  });

  // A private repository answers a token without contents: read with a 404, so the root listing's 404 means no access rather than no file.
  it.each([
    [404, 'Not Found'],
    [403, 'Resource not accessible by integration'],
    [401, 'Bad credentials'],
  ])('fails the root listing on HTTP %i as a configuration error that names contents: read', async (status, message) => {
    mocks.reposGetContent.mockRejectedValue(githubError(status, message));

    const client = new GitHubClient('token', 'owner', 'repo');
    const error = await client.listRootFiles(SHA).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(classifyFailure(error)).toBe('configuration');
    expect((error as Error).message).toBe(
      `Couldn't list the repository's files at 0123456: GitHub returned HTTP ${status}: ${message}. AutoTriage reads its policy and README through the API, so the workflow's permissions must grant contents: read.`
    );
  });

  it.each([
    ['a server error', githubError(503, 'Service Unavailable')],
    ['a rate limit', githubError(403, 'API rate limit exceeded for installation.', { 'x-ratelimit-remaining': '0' })],
  ])('lets %s from the root listing through unchanged, as a transient failure', async (_name, error) => {
    mocks.reposGetContent.mockRejectedValue(error);

    const client = new GitHubClient('token', 'owner', 'repo');

    await expect(client.listRootFiles(SHA)).rejects.toBe(error);
    expect(classifyFailure(error)).toBe('external');
  });

  it('reads a file as raw text at a commit', async () => {
    mocks.reposGetContent.mockResolvedValue({ data: '## Policy\n- Label bugs.\n' });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.readRepoFile('.github/AutoTriage.prompt', SHA)).toBe('## Policy\n- Label bugs.\n');
    expect(mocks.reposGetContent).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', path: '.github/AutoTriage.prompt', ref: SHA, mediaType: { format: 'raw' } });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('decodes a file that GitHub sends as bytes', async () => {
    mocks.reposGetContent.mockResolvedValue({ data: new TextEncoder().encode('# Café').buffer });

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.readRepoFile('README', SHA)).toBe('# Café');
  });

  it('reads a missing file as null', async () => {
    mocks.reposGetContent.mockRejectedValue(githubError(404, 'Not Found'));

    const client = new GitHubClient('token', 'owner', 'repo');

    expect(await client.readRepoFile('.github/AutoTriage.prompt', SHA)).toBeNull();
  });

  it('lets a 403 for a file through, so the run fails on the token or its permissions', async () => {
    const error = githubError(403, 'Resource not accessible by integration');
    mocks.reposGetContent.mockRejectedValue(error);

    const client = new GitHubClient('token', 'owner', 'repo');

    await expect(client.readRepoFile('.github/AutoTriage.prompt', SHA)).rejects.toBe(error);
    expect(classifyFailure(error)).toBe('configuration');
  });

  it('fails as a configuration error when the path is a directory, which GitHub answers with its listing', async () => {
    mocks.reposGetContent.mockResolvedValue({ data: [{ type: 'file', name: 'policy.md' }] });

    const client = new GitHubClient('token', 'owner', 'repo');

    await expect(client.readRepoFile('.github/AutoTriage.prompt', SHA)).rejects.toThrow(new ConfigurationError(".github/AutoTriage.prompt at 0123456 isn't a file."));
  });
});

describe('GitHubClient.listTimelineEvents', () => {
  const actor = { login: 'octocat', type: 'User' };
  const at = (day: number) => `2024-01-${String(day).padStart(2, '0')}T00:00:00Z`;

  it('keeps the fields that matter for each event type and drops notification noise', async () => {
    mocks.paginate.mockResolvedValueOnce([
      { event: 'committed', sha: 'abc123', author: { name: 'Dev', date: at(1) }, committer: { name: 'Dev', date: at(1) }, message: 'Fix it' },
      { event: 'renamed', actor, rename: { from: 'Old', to: 'New' }, created_at: at(2) },
      { event: 'assigned', actor, assignee: { login: 'dev' }, assigner: { login: 'lead' }, created_at: at(3) },
      { event: 'milestoned', actor, milestone: { title: 'v2' }, created_at: at(4) },
      { event: 'review_requested', actor, requested_team: { name: 'core' }, created_at: at(5) },
      { event: 'closed', actor, state_reason: 'not_planned', created_at: at(6) },
      { event: 'reopened', actor, created_at: at(7) },
      { event: 'reviewed', user: actor, state: 'approved', body: 'LGTM', submitted_at: at(8) },
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
      expect.objectContaining({ event: 'committed', sha: 'abc123', author: 'Dev', message: 'Fix it' }),
      expect.objectContaining({ event: 'renamed', from: 'Old', to: 'New' }),
      expect.objectContaining({ event: 'assigned', assignee: 'dev', assigner: 'lead' }),
      expect.objectContaining({ event: 'milestoned', milestone: 'v2' }),
      expect.objectContaining({ event: 'review_requested', requested_reviewer: 'core' }),
      expect.objectContaining({ event: 'closed', state: 'closed', state_reason: 'not_planned' }),
      expect.objectContaining({ event: 'reopened', state: 'open' }),
      expect.objectContaining({ event: 'reviewed', actor: 'octocat', state: 'approved', body: 'LGTM' }),
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

  it('dates commits and reviews so they sort among comments instead of crowding them out', async () => {
    const maintainer = { login: 'maintainer', id: 2, type: 'User', url: 'https://api.github.com/users/maintainer' };
    const contributor = { login: 'pat', id: 3, type: 'User', url: 'https://api.github.com/users/pat' };
    // Shaped like GitHub's timeline payloads: commits and reviews have no created_at, and a review names its author in user.
    const commit = (sha: string, authored: string, committed: string, message: string) => ({
      sha,
      node_id: `C_${sha}`,
      url: `https://api.github.com/repos/owner/repo/git/commits/${sha}`,
      html_url: `https://github.com/owner/repo/commit/${sha}`,
      author: { name: 'Pat Contributor', email: 'pat@example.com', date: authored },
      committer: { name: 'Pat Contributor', email: 'pat@example.com', date: committed },
      tree: { sha: `tree-${sha}`, url: `https://api.github.com/repos/owner/repo/git/trees/tree-${sha}` },
      message,
      parents: [],
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
      event: 'committed',
    });
    const comment = (id: number, user: typeof maintainer, association: string, created: string, body: string) => ({
      url: `https://api.github.com/repos/owner/repo/issues/comments/${id}`,
      html_url: `https://github.com/owner/repo/pull/42#issuecomment-${id}`,
      issue_url: 'https://api.github.com/repos/owner/repo/issues/42',
      id,
      node_id: `IC_${id}`,
      user,
      created_at: created,
      updated_at: created,
      body,
      author_association: association,
      reactions: { total_count: 0 },
      performed_via_github_app: null,
      event: 'commented',
      actor: user,
    });
    const review = {
      id: 7001,
      node_id: 'PRR_7001',
      user: maintainer,
      body: 'Thanks!',
      commit_id: 'c3',
      state: 'approved',
      html_url: 'https://github.com/owner/repo/pull/42#pullrequestreview-7001',
      pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/42',
      _links: { html: { href: 'https://github.com/owner/repo/pull/42#pullrequestreview-7001' } },
      submitted_at: at(6),
      updated_at: at(6),
      author_association: 'MEMBER',
      event: 'reviewed',
    };
    const payloads = [
      commit('a1', at(1), at(2), 'Fix the dropdown'),
      // Rebased after the comment below, so only its committer date is newer than that comment.
      commit('b2', at(1), at(4), 'Add a test'),
      comment(6001, maintainer, 'MEMBER', at(3), 'Could you add a test?'),
      commit('c3', at(5), at(5), 'Fix lint'),
      review,
      comment(6002, contributor, 'CONTRIBUTOR', at(7), 'Rebased on main.'),
    ];
    mocks.paginate.mockResolvedValueOnce(payloads);

    const client = new GitHubClient('token', 'owner', 'repo');
    const { raw, filtered } = await client.listTimelineEvents(42, 4);

    expect(raw).toEqual(payloads);
    expect(filtered).toEqual([
      { event: 'committed', created_at: at(4), sha: 'b2', author: 'Pat Contributor', message: 'Add a test' },
      { event: 'committed', created_at: at(5), sha: 'c3', author: 'Pat Contributor', message: 'Fix lint' },
      {
        event: 'reviewed',
        actor: 'maintainer',
        actor_type: 'User',
        actor_association: 'MEMBER',
        created_at: at(6),
        updated_at: at(6),
        state: 'approved',
        body: 'Thanks!',
      },
      {
        event: 'commented',
        actor: 'pat',
        actor_type: 'User',
        actor_association: 'CONTRIBUTOR',
        created_at: at(7),
        updated_at: at(7),
        body: 'Rebased on main.',
      },
    ]);
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

  // Only issue edits ask for the newer API version, because they are the only calls AutoTriage makes that the default version marks deprecated.
  const issueEditVersion = { headers: { 'x-github-api-version': '2026-03-10' } };

  it.each<[string, Parameters<GitHubClient['updateIssueState']>, object]>([
    ['clears the reason when reopening', [9, 'open'], { state: 'open', state_reason: null }],
    ['passes an explicit close reason', [9, 'closed', 'completed'], { state: 'closed', state_reason: 'completed' }],
    ['defaults a close without a reason to not_planned', [9, 'closed'], { state: 'closed', state_reason: 'not_planned' }],
  ])('updateIssueState %s', async (_label, args, expected) => {
    const client = new GitHubClient('token', 'owner', 'repo');

    await client.updateIssueState(...args);

    expect(mocks.issuesUpdate).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, ...expected, ...issueEditVersion });
    expect(client.getApiCallCount()).toBe(1);
  });

  it('sends title, comment, and label removal requests for the target item', async () => {
    const client = new GitHubClient('token', 'owner', 'repo');

    await client.updateTitle(9, 'Better title');
    await client.createComment(9, 'Hello');
    await client.removeLabel(9, 'needs info');

    expect(mocks.issuesUpdate).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, title: 'Better title', ...issueEditVersion });
    expect(mocks.issuesCreateComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, body: 'Hello' });
    expect(mocks.issuesRemoveLabel).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', issue_number: 9, name: 'needs info' });
    expect(client.getApiCallCount()).toBe(3);
  });
});
