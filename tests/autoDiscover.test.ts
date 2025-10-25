import { describe, expect, it } from 'vitest';
import { buildAutoDiscoverQueue } from '../src/autoDiscover';
import { Issue } from '../src/github';
import { TriageDb } from '../src/storage';

const baseIssue: Omit<Issue, 'number' | 'updated_at' | 'created_at'> = {
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

function makeIssue(number: number, updatedAt: string): Issue {
  return {
    ...baseIssue,
    number,
    updated_at: updatedAt,
    created_at: updatedAt,
  };
}

describe('buildAutoDiscoverQueue', () => {
  it('prioritizes issues not yet tracked in the database', () => {
    const db: TriageDb = {
      '4': { lastTriaged: '2024-04-04T00:00:00Z' },
    };
    const issues = [
      makeIssue(5, '2024-04-05T00:00:00Z'),
      makeIssue(4, '2024-04-04T00:00:00Z'),
      makeIssue(3, '2024-04-03T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([5, 3, 4]);
  });

  it('keeps updated tracked issues in the prioritized portion', () => {
    const db: TriageDb = {
      '10': { lastTriaged: '2024-04-01T00:00:00Z' },
    };
    const issues = [
      makeIssue(10, '2024-04-05T00:00:00Z'),
      makeIssue(9, '2024-04-04T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([10, 9]);
  });

  it('appends unchanged tracked issues while preserving their original order', () => {
    const db: TriageDb = {
      '3': { lastTriaged: '2024-04-05T00:00:00Z' },
      '2': { lastTriaged: '2024-04-03T00:00:00Z' },
    };
    const issues = [
      makeIssue(3, '2024-04-03T00:00:00Z'),
      makeIssue(2, '2024-04-02T00:00:00Z'),
      makeIssue(1, '2024-04-01T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([1, 3, 2]);
  });
});
