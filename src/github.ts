import * as github from '@actions/github';

export type Issue = {
  title: string;
  state: string;
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
};

export type TimelineEvent = {
  id?: number;
  url?: string;
  event: string;
  actor?: string;
  actor_association?: string;
  created_at?: string;
  updated_at?: string;
  submitted_at?: string;
  label?: { name?: string | null };
  body?: string;
  from?: string;
  to?: string;
  assignee?: string;
  requested_reviewer?: string;
  commit_id?: string;
  commit_url?: string;
  sha?: string;
  author?: string;
  message?: string;
  state?: string;
  state_reason?: string;
  merged?: boolean;
  milestone?: string | null;
  project?: string | null;
};

export class GitHubClient {
  private octokit;
  constructor(token: string, private owner: string, private repo: string) {
    this.octokit = github.getOctokit(token);
  }

  private buildMetadata(rawIssue: any): Issue {
    return {
      title: rawIssue.title,
      state: rawIssue.state,
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
    const { data } = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number });
    return this.buildMetadata(data);
  }

  async listOpenIssues(): Promise<Issue[]> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    return issues.map(issue => this.buildMetadata(issue));
  }

  async listRepoLabels(): Promise<Array<{ name: string; description?: string | null }>> {
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

  async listTimelineEvents(issue_number: number, limit: number): Promise<{ raw: any[]; filtered: TimelineEvent[] }> {
    const events = await this.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner: this.owner,
      repo: this.repo,
      issue_number,
      per_page: 100,
    });

    const sliced = (events as any[]).slice(-limit);
    const mapped = sliced.map<TimelineEvent | null>((event: any) => {
      const base: TimelineEvent = {
        id: event.id,
        url: event.url,
        event: event.event,
        actor: event.actor?.login,
        actor_association: event.actor?.author_association || event.author_association,
        created_at: event.created_at,
        updated_at: event.updated_at,
        //commit_id: event.commit_id,
        //commit_url: event.commit_url,
      };
      switch (event.event) {
        case 'committed':
          return { ...base, sha: event.sha, author: event.author?.login, message: event.message };
        case 'commented':
          return { ...base, body: event.body };
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
          return { ...base, submitted_at: event.submitted_at, state: event.state, body: event.body };
        case 'mentioned':
        case 'subscribed':
        case 'unsubscribed':
          return null;
        default:
          return base;
      }
    });
    return {
      raw: events,
      filtered: mapped.filter((ev): ev is TimelineEvent => ev !== null),
    };
  }

  async addLabels(issue_number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.octokit.rest.issues.addLabels({ owner: this.owner, repo: this.repo, issue_number, labels });
  }

  async removeLabel(issue_number: number, name: string): Promise<void> {
    await this.octokit.rest.issues.removeLabel({ owner: this.owner, repo: this.repo, issue_number, name });
  }

  async createComment(issue_number: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ owner: this.owner, repo: this.repo, issue_number, body });
  }

  async updateTitle(issue_number: number, title: string): Promise<void> {
    await this.octokit.rest.issues.update({ owner: this.owner, repo: this.repo, issue_number, title });
  }

  async closeIssue(
    issue_number: number,
    reason: 'completed' | 'not_planned' | 'reopened' | undefined = 'not_planned'
  ): Promise<void> {
    await this.octokit.rest.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number,
      state: 'closed',
      state_reason: reason,
    });
  }

  async updateIssueState(
    issue_number: number,
    state: 'open' | 'closed',
    reason?: 'completed' | 'not_planned'
  ): Promise<void> {
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
    timelineEvents: Array<TimelineEvent>,
    previousReactions?: number
  ): number {
    const parseTs = (s?: string): number => {
      if (!s) return 0;
      const v = Date.parse(s);
      return Number.isFinite(v) ? v : 0;
    };

    const issueUpdatedMs = parseTs(issue.updated_at);
    const latestEventMs = (timelineEvents || []).reduce((max, ev) => {
      const ts = parseTs(ev?.created_at);
      return ts > max ? ts : max;
    }, 0);

    let latest = issueUpdatedMs > latestEventMs ? issueUpdatedMs : latestEventMs;

    // If the total reactions count changed since last triage, consider that an update.
    if (typeof previousReactions === 'number' && typeof issue.reactions === 'number') {
      if (issue.reactions !== previousReactions) {
        // Use issue.updated_at if present; otherwise treat as "now" to force update.
        const fallbackNow = Date.now();
        const reactionUpdateMs = issueUpdatedMs || fallbackNow;
        if (reactionUpdateMs > latest) latest = reactionUpdateMs;
      }
    }

    return latest;
  }

  hasUpdated(
    issue: Issue,
    timelineEvents: Array<TimelineEvent>,
    lastTriaged: Date | null,
    previousReactions?: number
  ): boolean {
    if (!lastTriaged) return true; // No prior triage => treat as updated.
    const latestUpdateMs = this.lastUpdated(issue, timelineEvents, previousReactions);
    const hasChangeSinceTriage = latestUpdateMs > lastTriaged.getTime();
    return hasChangeSinceTriage;
  }
}
