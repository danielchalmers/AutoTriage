import * as github from '@actions/github';

export type IssueLike = {
  number: number;
  title: string;
  state: string;
  body?: string | null;
  user?: { login?: string; type?: string };
  draft?: boolean;
  locked?: boolean;
  milestone?: { title?: string } | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  comments?: number;
  reactions?: { total_count?: number };
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }>;
  assignee?: { login?: string } | null;
  pull_request?: unknown;
};

export class GitHubClient {
  private octokit;
  constructor(token: string, private owner: string, private repo: string) {
    this.octokit = github.getOctokit(token);
  }

  async getIssue(issue_number: number): Promise<IssueLike> {
    const { data } = await this.octokit.rest.issues.get({ owner: this.owner, repo: this.repo, issue_number });
    return data as IssueLike;
  }

  async listOpenIssues(): Promise<IssueLike[]> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      owner: this.owner,
      repo: this.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    return issues as IssueLike[];
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
}
