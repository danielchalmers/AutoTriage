import * as github from '@actions/github';

type IssueLike = {
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

export function getOctokit(token: string): any {
  return github.getOctokit(token);
}

export async function getIssue(octokit: any, owner: string, repo: string, issue_number: number) {
  const { data } = await octokit.rest.issues.get({ owner, repo, issue_number });
  return data as IssueLike;
}

export async function listOpenIssues(octokit: any, owner: string, repo: string) {
  const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  });
  return issues as IssueLike[];
}

export async function listRepoLabels(octokit: any, owner: string, repo: string): Promise<string[]> {
  const labels = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner,
    repo,
    per_page: 100,
  });
  return (labels as any[])
    .map((l: any) => (typeof l?.name === 'string' ? l.name : ''))
    .filter((n: string) => n.length > 0);
}

export async function listTimelineEvents(
  octokit: any,
  owner: string,
  repo: string,
  issue_number: number,
  limit: number
) {
  const events = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/timeline', {
    owner,
    repo,
    issue_number,
    per_page: 100,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28',
    },
    mediaType: { previews: ['mockingbird'] },
  });

  const sliced = (events as any[]).slice(-limit);
  return sliced.map((event: any) => {
    const base = { event: event.event, actor: event.actor?.login, timestamp: event.created_at };
    switch (event.event) {
      case 'commented':
        return { ...base, body: typeof event.body === 'string' ? event.body.slice(0, 2000) : undefined };
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

export async function addLabels(octokit: any, owner: string, repo: string, issue_number: number, labels: string[]) {
  if (labels.length === 0) return;
  await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels });
}

export async function removeLabel(octokit: any, owner: string, repo: string, issue_number: number, name: string) {
  await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name });
}

export async function createComment(
  octokit: any,
  owner: string,
  repo: string,
  issue_number: number,
  body: string
) {
  await octokit.rest.issues.createComment({ owner, repo, issue_number, body });
}

export async function updateTitle(
  octokit: any,
  owner: string,
  repo: string,
  issue_number: number,
  title: string
) {
  await octokit.rest.issues.update({ owner, repo, issue_number, title });
}

export async function closeIssue(
  octokit: any,
  owner: string,
  repo: string,
  issue_number: number,
  reason: 'completed' | 'not_planned' | 'reopened' | 'duplicate' | undefined = 'not_planned'
) {
  await octokit.rest.issues.update({ owner, repo, issue_number, state: 'closed', state_reason: reason });
}

export function isBot(issue: IssueLike): boolean {
  return (issue.user?.type || '').toLowerCase() === 'bot';
}

export type { IssueLike };
