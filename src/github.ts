import * as github from '@actions/github';
import { parseTimestamp } from './util';

export type Issue = {
  title: string;
  state: string;
  state_reason?: string | null;
  type: string;
  number: number;
  author: string;
  user_type: string;
  author_association?: string;
  draft: boolean;
  locked: boolean;
  milestone: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  comments: number;
  reactions: number;
  labels: string[];
  assignees: string[];
  body?: string | null;
  changed_files?: string[];
};

export type TimelineEvent = {
  id?: number | null;
  url?: string | null;
  event: string;
  actor?: string | null;
  actor_type?: string | null;
  actor_association?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  submitted_at?: string | null;
  label?: { name?: string | null };
  body?: string | null;
  path?: string | null;
  from?: string | null;
  to?: string | null;
  assignee?: string | null;
  assigner?: string | null;
  requested_reviewer?: string | null;
  sha?: string | null;
  author?: string | null;
  author_type?: string | null;
  committer?: string | null;
  committer_type?: string | null;
  message?: string | null;
  edit_from?: string | null;
  edited_field?: string | null;
  state?: string;
  state_reason?: string;
  merged?: boolean;
  milestone?: string | null;
};

export type TimelineCompleteness = {
  history_fetched: boolean;
  discussion_truncated: boolean;
  total_events: number;
  retained_events: number;
  omitted_events: number;
  coverage_start: string | null;
  coverage_end: string | null;
  missing_actor_count: number;
  missing_timestamp_count: number;
  body_edit_history: 'timeline_events_only' | 'unavailable';
  review_comments_available: boolean;
};

export type TimelineCollection = {
  raw: any[];
  filtered: TimelineEvent[];
  activityEvidence: TimelineEvent[];
  completeness: TimelineCompleteness;
};

export class GitHubClient {
  private octokit;
  private apiCallCount = 0;
  
  constructor(token: string, private owner: string, private repo: string) {
    this.octokit = github.getOctokit(token);
  }

  getApiCallCount(): number {
    return this.apiCallCount;
  }

  private incrementApiCalls(): void {
    this.apiCallCount++;
  }

  private buildMetadata(rawIssue: any): Issue {
    return {
      title: rawIssue.title,
      state: rawIssue.state,
      state_reason: rawIssue.state_reason ?? null,
      type: rawIssue.pull_request ? 'pull request' : 'issue',
      number: rawIssue.number,
      author: rawIssue.user?.login || 'unknown',
      user_type: rawIssue.user?.type || 'unknown',
      author_association: rawIssue.author_association,
      draft: !!rawIssue.draft,
      locked: !!rawIssue.locked,
      milestone: rawIssue.milestone?.title || null,
      created_at: rawIssue.created_at,
      updated_at: rawIssue.updated_at,
      closed_at: rawIssue.closed_at || null,
      comments: rawIssue.comments || 0,
      reactions: rawIssue.reactions?.total_count || 0,
      labels: (rawIssue.labels || []).map((l: any) => typeof l === 'string' ? l : (l.name || '')),
      assignees: Array.isArray(rawIssue.assignees) ? rawIssue.assignees.map((a: any) => a.login || '') : (rawIssue.assignee ? [rawIssue.assignee.login || ''] : []),
      body: rawIssue.body,
    };
  }

  async getIssue(issue_number: number): Promise<Issue> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number });
    const metadata = this.buildMetadata(data);

    if (data.pull_request) {
      this.incrementApiCalls();
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner: this.owner,
        repo: this.repo,
        pull_number: issue_number,
        per_page: 100,
      });
      metadata.changed_files = (files as any[])
        .map((file: any) => file?.filename)
        .filter((filename: unknown): filename is string => typeof filename === 'string');
    }

    return metadata;
  }

  async listOpenIssues(): Promise<Issue[]> {
    this.incrementApiCalls();
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    return issues.map((issue: any) => this.buildMetadata(issue));
  }

  async listRecentlyClosedIssues(limit: number = 100): Promise<Issue[]> {
    this.incrementApiCalls();
    const { data } = await this.octokit.rest.issues.listForRepo({
      owner: this.owner,
      repo: this.repo,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: Math.min(Math.max(limit, 1), 100),
      page: 1,
    });
    return data.map((issue: any) => this.buildMetadata(issue));
  }

  async listRepoLabels(): Promise<Array<{ name: string; description?: string | null }>> {
    this.incrementApiCalls();
    const labels = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, {
      owner: this.owner,
      repo: this.repo,
      per_page: 100,
    });
    return (labels as any[])
      .map((l: any) => {
        const name: string | undefined = typeof l?.name === 'string' ? l.name : undefined;
        if (!name) return null;
        return {
          name,
          description: typeof l?.description === 'string' && l.description.trim().length > 0 ? l.description : null,
        } as { name: string; description: string | null };
      })
      .filter((l: any): l is { name: string; description: string | null } => !!l);
  }

  private async listReviewComments(issue_number: number): Promise<TimelineEvent[]> {
    this.incrementApiCalls();
    const comments = await this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
      owner: this.owner,
      repo: this.repo,
      pull_number: issue_number,
      per_page: 100,
    });

    return (comments as any[]).map((comment: any) => ({
      event: 'review_commented',
      id: comment.id ?? null,
      url: comment.html_url ?? comment.url ?? null,
      actor: comment.user?.login ?? null,
      actor_type: comment.user?.type ?? null,
      actor_association: comment.author_association,
      created_at: comment.created_at,
      updated_at: comment.updated_at,
      submitted_at: null,
      body: comment.body,
      path: comment.path,
      sha: comment.commit_id ?? null,
    }));
  }

  async listTimelineEvents(
    issue_number: number,
    limit: number,
    isPullRequest: boolean = false
  ): Promise<TimelineCollection> {
    this.incrementApiCalls();
    const events = await this.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner: this.owner,
      repo: this.repo,
      issue_number,
      per_page: 100,
    });

    const mapped = (events as any[]).map<TimelineEvent | null>((event: any) => {
      const base: TimelineEvent = {
        id: event.id ?? null,
        url: event.html_url ?? event.url ?? null,
        event: event.event,
        actor: event.actor?.login ?? null,
        actor_type: event.actor?.type ?? null,
        actor_association: event.actor?.author_association ?? event.author_association ?? null,
        created_at: event.created_at ?? null,
        updated_at: event.updated_at ?? null,
        submitted_at: event.submitted_at ?? null,
      };
      switch (event.event) {
        case 'committed':
          return {
            ...base,
            sha: event.sha ?? null,
            author: event.author?.login ?? null,
            author_type: event.author?.type ?? null,
            committer: event.committer?.login ?? null,
            committer_type: event.committer?.type ?? null,
            message: event.message ?? null,
          };
        case 'commented':
          return { ...base, body: event.body ?? null };
        case 'edited':
          return {
            ...base,
            edited_field: event.changes?.body ? 'body' : null,
            edit_from: event.changes?.body?.from ?? null,
          };
        case 'labeled':
        case 'unlabeled':
          return { ...base, label: { name: event.label?.name } };
        case 'renamed':
          return { ...base, from: event.rename?.from, to: event.rename?.to };
        case 'assigned':
        case 'unassigned':
          return { ...base, assignee: event.assignee?.login, assigner: event.assigner?.login };
        case 'milestoned':
        case 'demilestoned':
          return { ...base, milestone: event.milestone?.title ?? null };
        case 'review_dismissed':
        case 'review_requested':
        case 'review_request_removed':
          return { ...base, requested_reviewer: event.requested_reviewer?.login || event.requested_team?.name };
        case 'closed':
          return { ...base, state: 'closed', state_reason: event.state_reason };
        case 'reopened':
          return { ...base, state: 'open' };
        case 'merged':
          return { ...base, merged: true };
        case 'reviewed':
          return { ...base, state: event.state, body: event.body ?? null };
        default:
          return base;
      }
    });
    const timelineEvents = mapped.filter((ev): ev is TimelineEvent => ev !== null);
    let reviewComments: TimelineEvent[] = [];
    let reviewCommentsAvailable = true;
    if (isPullRequest) {
      try {
        reviewComments = await this.listReviewComments(issue_number);
      } catch {
        reviewCommentsAvailable = false;
      }
    }
    const allEvents = timelineEvents.concat(reviewComments)
      .sort((a, b) => {
        const aTs = eventTimestamp(a);
        const bTs = eventTimestamp(b);
        return (Number.isNaN(aTs) ? Number.MAX_SAFE_INTEGER : aTs) - (Number.isNaN(bTs) ? Number.MAX_SAFE_INTEGER : bTs);
      });
    const filtered = allEvents.slice(-limit);
    const timestamped = allEvents.map(eventTimestamp).filter((ts) => !Number.isNaN(ts));
    const editEvents = allEvents.filter((event) => event.event === 'edited' && event.edited_field === 'body');

    return {
      raw: events,
      filtered,
      activityEvidence: allEvents,
      completeness: {
        history_fetched: true,
        discussion_truncated: filtered.length < allEvents.length,
        total_events: allEvents.length,
        retained_events: filtered.length,
        omitted_events: Math.max(0, allEvents.length - filtered.length),
        coverage_start: timestamped.length > 0 ? new Date(Math.min(...timestamped)).toISOString() : null,
        coverage_end: timestamped.length > 0 ? new Date(Math.max(...timestamped)).toISOString() : null,
        missing_actor_count: allEvents.filter((event) => !event.actor).length,
        missing_timestamp_count: allEvents.filter((event) => Number.isNaN(eventTimestamp(event))).length,
        body_edit_history: editEvents.length > 0 ? 'timeline_events_only' : 'unavailable',
        review_comments_available: reviewCommentsAvailable,
      },
    };
  }

  async addLabels(issue_number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    this.incrementApiCalls();
    await this.octokit.rest.issues.addLabels({ owner: this.owner, repo: this.repo, issue_number, labels });
  }

  async removeLabel(issue_number: number, name: string): Promise<void> {
    this.incrementApiCalls();
    await this.octokit.rest.issues.removeLabel({ owner: this.owner, repo: this.repo, issue_number, name });
  }

  async createComment(issue_number: number, body: string): Promise<void> {
    this.incrementApiCalls();
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number, body });
  }

  async updateTitle(issue_number: number, title: string): Promise<void> {
    this.incrementApiCalls();
    await this.octokit.rest.issues.update({ owner: this.owner, repo: this.repo, issue_number, title });
  }

  async updateIssueState(
    issue_number: number,
    state: 'open' | 'closed',
    reason?: 'completed' | 'not_planned'
  ): Promise<void> {
    this.incrementApiCalls();
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number,
      state,
      state_reason: state === 'closed' ? (reason ?? 'not_planned') : null,
    });
  }

  lastUpdated(
    issue: Issue,
    timelineEvents: Array<TimelineEvent>
  ): number {
    const issueUpdatedMs = parseTimestamp(issue.updated_at);
    const latestEventMs = (timelineEvents || []).reduce((max, ev) => {
      const ts = Math.max(
        parseTimestamp(ev?.created_at),
        parseTimestamp(ev?.updated_at),
        parseTimestamp(ev?.submitted_at)
      );
      return ts > max ? ts : max;
    }, 0);

    return issueUpdatedMs > latestEventMs ? issueUpdatedMs : latestEventMs;
  }
}

function eventTimestamp(event: TimelineEvent): number {
  const timestamps = [event.created_at, event.updated_at, event.submitted_at]
    .map((value) => Date.parse(value ?? ''))
    .filter((value) => !Number.isNaN(value));
  return timestamps.length > 0 ? Math.max(...timestamps) : Number.NaN;
}
