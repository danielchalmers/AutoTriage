import { describe, expect, it } from 'vitest';
import { buildAutoDiscoverQueue, prioritizeIssueNumbers } from '../src/autoDiscover';
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

  it('appends unchanged tracked issues sorted by lastTriaged (oldest first)', () => {
    const db: TriageDb = {
      '3': { lastTriaged: '2024-04-05T00:00:00Z' },
      '2': { lastTriaged: '2024-04-03T00:00:00Z' },
    };
    const issues = [
      makeIssue(3, '2024-04-03T00:00:00Z'),
      makeIssue(2, '2024-04-02T00:00:00Z'),
      makeIssue(1, '2024-04-01T00:00:00Z'),
    ];

    // Issue #1 is not in DB so it's prioritized first
    // Issues #2 and #3 are unchanged, sorted by lastTriaged: #2 (04-03) before #3 (04-05)
    expect(buildAutoDiscoverQueue(issues, db)).toEqual([1, 2, 3]);
  });

  it('sorts secondary bucket by lastTriaged with oldest first', () => {
    const db: TriageDb = {
      '10': { lastTriaged: '2024-10-10T00:00:00Z' },
      '11': { lastTriaged: '2024-11-11T00:00:00Z' },
      '9': { lastTriaged: '2024-09-09T00:00:00Z' },
    };
    const issues = [
      makeIssue(11, '2024-11-10T00:00:00Z'),
      makeIssue(10, '2024-10-09T00:00:00Z'),
      makeIssue(9, '2024-09-08T00:00:00Z'),
    ];

    // All issues are unchanged (updated before lastTriaged), so sorted by lastTriaged
    // Order should be: #9 (Sep 9), #10 (Oct 10), #11 (Nov 11)
    expect(buildAutoDiscoverQueue(issues, db)).toEqual([9, 10, 11]);
  });

  it('handles mixed prioritized and secondary issues correctly', () => {
    const db: TriageDb = {
      '5': { lastTriaged: '2024-04-05T00:00:00Z' },
      '4': { lastTriaged: '2024-04-04T00:00:00Z' },
      '3': { lastTriaged: '2024-04-03T00:00:00Z' },
    };
    const issues = [
      makeIssue(6, '2024-04-06T00:00:00Z'), // Not in DB - prioritized
      makeIssue(5, '2024-04-10T00:00:00Z'), // Updated after triage - prioritized
      makeIssue(4, '2024-04-02T00:00:00Z'), // Not updated - secondary
      makeIssue(3, '2024-04-01T00:00:00Z'), // Not updated - secondary
      makeIssue(2, '2024-04-01T00:00:00Z'), // Not in DB - prioritized
    ];

    // Prioritized (in GitHub order): #6, #5, #2
    // Secondary (by lastTriaged oldest first): #3 (04-03), #4 (04-04)
    expect(buildAutoDiscoverQueue(issues, db)).toEqual([6, 5, 2, 3, 4]);
  });

  it('handles issues with missing lastTriaged in secondary bucket', () => {
    const db: TriageDb = {
      '3': { lastTriaged: '2024-04-03T00:00:00Z' },
      '2': { }, // No lastTriaged field
    };
    const issues = [
      makeIssue(3, '2024-04-02T00:00:00Z'),
      makeIssue(2, '2024-04-01T00:00:00Z'),
    ];

    // Both are unchanged/secondary. #2 has no lastTriaged (0), #3 has timestamp
    // Order: #2 (0) before #3 (timestamp)
    expect(buildAutoDiscoverQueue(issues, db)).toEqual([2, 3]);
  });

  describe('skipUnchanged parameter', () => {
    it('excludes unchanged issues when skipUnchanged is true', () => {
      const db: TriageDb = {
        '4': { lastTriaged: '2024-04-04T00:00:00Z' },
        '3': { lastTriaged: '2024-04-03T00:00:00Z' },
      };
      const issues = [
        makeIssue(5, '2024-04-05T00:00:00Z'), // Not in DB - prioritized
        makeIssue(4, '2024-04-02T00:00:00Z'), // Unchanged - should be excluded
        makeIssue(3, '2024-04-01T00:00:00Z'), // Unchanged - should be excluded
      ];

      // With skipUnchanged=true, only #5 (not in DB) should be included
      expect(buildAutoDiscoverQueue(issues, db, true)).toEqual([5]);
    });

    it('includes unchanged issues when skipUnchanged is false', () => {
      const db: TriageDb = {
        '4': { lastTriaged: '2024-04-04T00:00:00Z' },
        '3': { lastTriaged: '2024-04-03T00:00:00Z' },
      };
      const issues = [
        makeIssue(5, '2024-04-05T00:00:00Z'), // Not in DB - prioritized
        makeIssue(4, '2024-04-02T00:00:00Z'), // Unchanged - included in secondary
        makeIssue(3, '2024-04-01T00:00:00Z'), // Unchanged - included in secondary
      ];

      // With skipUnchanged=false (default), all should be included
      expect(buildAutoDiscoverQueue(issues, db, false)).toEqual([5, 3, 4]);
    });

    it('includes updated issues even when skipUnchanged is true', () => {
      const db: TriageDb = {
        '5': { lastTriaged: '2024-04-01T00:00:00Z' },
        '4': { lastTriaged: '2024-04-04T00:00:00Z' },
        '3': { lastTriaged: '2024-04-03T00:00:00Z' },
      };
      const issues = [
        makeIssue(6, '2024-04-06T00:00:00Z'), // Not in DB - prioritized
        makeIssue(5, '2024-04-10T00:00:00Z'), // Updated after triage - prioritized
        makeIssue(4, '2024-04-02T00:00:00Z'), // Unchanged - excluded
        makeIssue(3, '2024-04-01T00:00:00Z'), // Unchanged - excluded
      ];

      // With skipUnchanged=true, only #6 (not in DB) and #5 (updated) should be included
      expect(buildAutoDiscoverQueue(issues, db, true)).toEqual([6, 5]);
    });

    it('behaves the same as false when skipUnchanged is not provided', () => {
      const db: TriageDb = {
        '4': { lastTriaged: '2024-04-04T00:00:00Z' },
        '3': { lastTriaged: '2024-04-03T00:00:00Z' },
      };
      const issues = [
        makeIssue(5, '2024-04-05T00:00:00Z'),
        makeIssue(4, '2024-04-02T00:00:00Z'),
        makeIssue(3, '2024-04-01T00:00:00Z'),
      ];

      // Default behavior (no skipUnchanged) should be same as skipUnchanged=false
      expect(buildAutoDiscoverQueue(issues, db)).toEqual([5, 3, 4]);
    });
  });
});

describe('prioritizeIssueNumbers', () => {
  it('moves the priority number to the front when present', () => {
    expect(prioritizeIssueNumbers([3, 6, 10], 10)).toEqual([10, 3, 6]);
  });

  it('prepends the priority number when missing', () => {
    expect(prioritizeIssueNumbers([3, 6], 10)).toEqual([10, 3, 6]);
  });
});
