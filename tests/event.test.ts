import { describe, expect, it, vi } from 'vitest';
import { TRIGGER_RECENCY_WINDOW, resolveEventTarget } from '../src/event';
import { makePullRequest, makeSameRepoWorkflowRunEvent, makeWorkflowRunEvent } from './fixtures';

function createGitHub() {
  return {
    getPullRequest: vi.fn(async (n: number) => makePullRequest(n)),
    listOpenPullRequestsByHead: vi.fn(async () => [makePullRequest(12)]),
    getLastReadyForReview: vi.fn(async (): Promise<string | undefined> => undefined),
  };
}

describe('resolveEventTarget', () => {
  it.each([
    ['issues', { action: 'opened', issue: { number: 7 } }],
    ['issue_comment', { action: 'created', issue: { number: 7, pull_request: {} }, comment: { id: 1 } }],
    ['pull_request', { action: 'opened', number: 7, pull_request: { number: 7 } }],
    ['pull_request_target', { action: 'opened', number: 7, pull_request: { number: 7 } }],
  ])('triages the item a %s event names', async (name, payload) => {
    expect(await resolveEventTarget({ name, payload }, createGitHub())).toEqual({ kind: 'item', number: 7 });
  });

  it.each([
    ['a schedule event', 'schedule', { schedule: '23 8 * * *' }],
    ['a workflow_dispatch event', 'workflow_dispatch', { inputs: { issues: '' } }],
    ['a local run with no event name', undefined, {}],
  ])('sweeps the backlog for %s', async (_label, name, payload) => {
    expect(await resolveEventTarget({ name, payload }, createGitHub())).toEqual({ kind: 'sweep' });
  });

  it('triages nothing for an event that names no item, such as a push', async () => {
    expect(await resolveEventTarget({ name: 'push', payload: { ref: 'refs/heads/main', commits: [] } }, createGitHub())).toEqual({
      kind: 'none',
      notice: 'Nothing to triage for the push event, because it names no issue or pull request and only schedule and workflow_dispatch events sweep the backlog.',
    });
  });
});

describe('resolveEventTarget for a workflow_run event', () => {
  it.each(['pull_request', 'pull_request_target'])('triages a same-repository pull request listed on a %s run, without looking it up by branch', async (event) => {
    const gh = createGitHub();

    expect(await resolveEventTarget(makeSameRepoWorkflowRunEvent(12, { event }), gh)).toEqual({ kind: 'item', number: 12, via: 'PR #12 (listed on the workflow run)' });
    expect(gh.getPullRequest).toHaveBeenCalledExactlyOnceWith(12);
    expect(gh.listOpenPullRequestsByHead).not.toHaveBeenCalled();
    expect(gh.getLastReadyForReview).not.toHaveBeenCalled();
  });

  it("finds a fork's pull request by owner:branch and the run's head SHA, ignoring pull requests listed for other repositories", async () => {
    const gh = createGitHub();
    gh.listOpenPullRequestsByHead.mockResolvedValue([makePullRequest(11, { head_sha: 'old999' }), makePullRequest(12)]);
    const elsewhere = { id: 3003, name: 'repo', url: 'https://api.github.com/repos/pat/repo' };
    const event = makeWorkflowRunEvent({ pull_requests: [{ number: 4, head: { ref: 'main', sha: 'abc123', repo: elsewhere }, base: { ref: 'main', sha: 'f00', repo: elsewhere } }] });

    expect(await resolveEventTarget(event, gh)).toEqual({ kind: 'item', number: 12, via: 'PR #12 (fork lookup by pat:fix-typo, head SHA matched)' });
    expect(gh.listOpenPullRequestsByHead).toHaveBeenCalledExactlyOnceWith('pat:fix-typo');
    expect(gh.getPullRequest).not.toHaveBeenCalled();
  });

  it('takes the only open pull request from owner:branch when a push after opening moved its head past the run', async () => {
    const gh = createGitHub();
    gh.listOpenPullRequestsByHead.mockResolvedValue([makePullRequest(12, { head_sha: 'newer456' })]);

    expect(await resolveEventTarget(makeWorkflowRunEvent(), gh)).toEqual({ kind: 'item', number: 12, via: 'PR #12 (fork lookup by pat:fix-typo, the only open match)' });
  });

  it.each([
    ['no open pull request comes from owner:branch', [], 'No open pull request comes from pat:fix-typo, so the workflow_run event has nothing to triage.'],
    [
      "several open pull requests come from owner:branch and none has the run's head SHA",
      [makePullRequest(11, { head_sha: 'old999' }), makePullRequest(12, { head_sha: 'newer456' })],
      "2 open pull requests come from pat:fix-typo and none has the run's head SHA, so the workflow_run event has nothing to triage.",
    ],
  ])('triages nothing when %s', async (_name, open, notice) => {
    const gh = createGitHub();
    gh.listOpenPullRequestsByHead.mockResolvedValue(open);

    expect(await resolveEventTarget(makeWorkflowRunEvent(), gh)).toEqual({ kind: 'none', notice });
  });

  it('triages nothing when the run has no head repository, as when the fork was deleted', async () => {
    const gh = createGitHub();

    expect(await resolveEventTarget(makeWorkflowRunEvent({ head_repository: null }), gh)).toEqual({
      kind: 'none',
      notice: 'Nothing to triage for the workflow_run event, because the run it reports has no head repository or branch to find its pull request by.',
    });
    expect(gh.listOpenPullRequestsByHead).not.toHaveBeenCalled();
  });

  it('triages nothing for a workflow_run event whose run was not for a pull request, without calling GitHub', async () => {
    const gh = createGitHub();

    expect(await resolveEventTarget(makeSameRepoWorkflowRunEvent(12, { event: 'push' }), gh)).toEqual({
      kind: 'none',
      notice: 'Nothing to triage for the workflow_run event, because the run it reports was triggered by push, not by a pull request.',
    });
    expect(gh.getPullRequest).not.toHaveBeenCalled();
    expect(gh.listOpenPullRequestsByHead).not.toHaveBeenCalled();
  });

  it('skips a draft pull request', async () => {
    const gh = createGitHub();
    gh.listOpenPullRequestsByHead.mockResolvedValue([makePullRequest(12, { draft: true })]);

    expect(await resolveEventTarget(makeWorkflowRunEvent(), gh)).toEqual({ kind: 'none', notice: 'PR #12 is a draft, so the workflow_run event has nothing to triage.' });
  });

  it('skips a pull request that was closed after its run was listed', async () => {
    const gh = createGitHub();
    gh.getPullRequest.mockResolvedValue(makePullRequest(12, { state: 'closed' }));

    expect(await resolveEventTarget(makeSameRepoWorkflowRunEvent(12), gh)).toEqual({ kind: 'none', notice: 'PR #12 is closed, so the workflow_run event has nothing to triage.' });
  });

  it('skips a trigger run created long after the pull request was opened or marked ready for review', async () => {
    const gh = createGitHub();
    gh.getLastReadyForReview.mockResolvedValue('2026-10-11T12:00:00Z');

    expect(await resolveEventTarget(makeSameRepoWorkflowRunEvent(12, { created_at: '2026-10-11T13:00:00Z' }), gh)).toEqual({
      kind: 'none',
      notice: "PR #12 isn't triaged, because the workflow run was created at 2026-10-11T13:00:00Z, which isn't between 1 minute before and 10 minutes after the PR was opened or last marked ready for review.",
    });
    expect(gh.getLastReadyForReview).toHaveBeenCalledExactlyOnceWith(12);
  });

  it('triages a pull request opened as a draft long ago once a run follows it being marked ready for review', async () => {
    const gh = createGitHub();
    gh.getPullRequest.mockResolvedValue(makePullRequest(12, { created_at: '2026-10-01T09:00:00Z' }));
    gh.getLastReadyForReview.mockResolvedValue('2026-10-11T12:00:00Z');

    expect(await resolveEventTarget(makeSameRepoWorkflowRunEvent(12), gh)).toMatchObject({ kind: 'item', number: 12 });
  });

  it.each([
    [-TRIGGER_RECENCY_WINDOW.beforeMs, 'item'],
    [-TRIGGER_RECENCY_WINDOW.beforeMs - 1000, 'none'],
    [TRIGGER_RECENCY_WINDOW.afterMs, 'item'],
    [TRIGGER_RECENCY_WINDOW.afterMs + 1000, 'none'],
  ])('with the run created %ims after the pull request opened, resolves to %s', async (offsetMs, kind) => {
    const created = Date.parse('2026-10-11T12:00:00Z');
    const gh = createGitHub();

    const target = await resolveEventTarget(makeSameRepoWorkflowRunEvent(12, { created_at: new Date(created + offsetMs).toISOString() }), gh);

    expect(target.kind).toBe(kind);
  });

  it('triages nothing when the run has no creation time to check', async () => {
    const gh = createGitHub();

    expect(await resolveEventTarget(makeSameRepoWorkflowRunEvent(12, { created_at: null }), gh)).toMatchObject({ kind: 'none' });
    expect(gh.getPullRequest).not.toHaveBeenCalled();
  });
});
