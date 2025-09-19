import * as github from '@actions/github';

export type Issue = {
  title: string;
  state: string;
  type: string;
  number: number;
  author: string;
  user_type: string;
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

  async listTimelineEvents(issue_number: number, limit: number): Promise<any[]> {
    const events = await this.octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
      owner: this.owner,
      repo: this.repo,
      issue_number,
      per_page: 100,
    });

    const sliced = (events as any[]).slice(-limit);
    return sliced.map((event: any) => {
      const base = { event: event.event, actor: event.actor?.login, timestamp: event.created_at };
      switch (event.event) {
        case 'commented':
          return { ...base, body: typeof event.body === 'string' ? event.body.slice(0, 10000) : undefined };
        case 'labeled':
        case 'unlabeled':
          return { ...base, label: { name: event.label?.name, color: event.label?.color } };
        case 'renamed':
          return { ...base, from: event.rename?.from, to: event.rename?.to };
        default:
          return base;
      }
    });
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
    timelineEvents: Array<{ timestamp?: string }>,
    previousReactions?: number
  ): number {
    const parseTs = (s?: string): number => {
      if (!s) return 0;
      const v = Date.parse(s);
      return Number.isFinite(v) ? v : 0;
    };

    const issueUpdatedMs = parseTs(issue.updated_at);
    const latestEventMs = (timelineEvents || []).reduce((max, ev) => {
      const ts = parseTs(ev?.timestamp);
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
    timelineEvents: Array<{ timestamp?: string }>,
    lastTriaged: Date | null,
    previousReactions?: number
  ): boolean {
    if (!lastTriaged) return true; // No prior triage => treat as updated.
    const latestUpdateMs = this.lastUpdated(issue, timelineEvents, previousReactions);
    const hasChangeSinceTriage = latestUpdateMs > lastTriaged.getTime();
    return hasChangeSinceTriage;
  }
}
