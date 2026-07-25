import { Issue } from '../src/github';
import { TriageDb } from '../src/storage';

export const baseIssue: Omit<Issue, 'number' | 'updated_at' | 'created_at'> = {
  title: 'Sample',
  state: 'open',
  type: 'issue',
  author: 'octocat',
  user_type: 'User',
  draft: false,
  locked: false,
  milestone: null,
  comments: 0,
  reactions: 0,
  labels: [],
  assignees: [],
  body: null,
};

export function makeIssue(number: number, updatedAt: string): Issue {
  return {
    ...baseIssue,
    number,
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}

export function makeClosedIssue(number: number, closedAt: string, updatedAt: string): Issue {
  return {
    ...makeIssue(number, updatedAt),
    state: 'closed',
    closed_at: closedAt,
  };
}

export function makeDb(items: TriageDb['items'] = {}): TriageDb {
  return {
    version: 2,
    items,
  };
}
