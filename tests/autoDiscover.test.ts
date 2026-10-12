import { describe, expect, it } from 'vitest';
import { buildAutoDiscoverQueue, filterPreviouslyTriagedClosedIssuesWithNewActivity } from '../src/autoDiscover';
import { makeClosedIssue, makeDb, makeIssue } from './fixtures';

describe('buildAutoDiscoverQueue', () => {
  it('prioritizes issues not yet tracked in the database', () => {
    const db = makeDb({
      '4': { lastTriaged: '2024-04-04T00:00:00Z' },
    });
    const issues = [
      makeIssue(5, '2024-04-05T00:00:00Z'),
      makeIssue(4, '2024-04-04T00:00:00Z'),
      makeIssue(3, '2024-04-03T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([5, 3, 4]);
  });

  it('keeps updated tracked issues in the prioritized portion', () => {
    const db = makeDb({
      '10': { lastTriaged: '2024-04-01T00:00:00Z' },
    });
    const issues = [
      makeIssue(10, '2024-04-05T00:00:00Z'),
      makeIssue(9, '2024-04-04T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([10, 9]);
  });

  it('appends unchanged tracked issues sorted by lastTriaged (oldest first)', () => {
    const db = makeDb({
      '3': { lastTriaged: '2024-04-05T00:00:00Z' },
      '2': { lastTriaged: '2024-04-03T00:00:00Z' },
    });
    const issues = [
      makeIssue(3, '2024-04-03T00:00:00Z'),
      makeIssue(2, '2024-04-02T00:00:00Z'),
      makeIssue(1, '2024-04-01T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([1, 2, 3]);
  });

  it('handles mixed prioritized and secondary issues correctly', () => {
    const db = makeDb({
      '5': { lastTriaged: '2024-04-05T00:00:00Z' },
      '4': { lastTriaged: '2024-04-04T00:00:00Z' },
      '3': { lastTriaged: '2024-04-03T00:00:00Z' },
    });
    const issues = [
      makeIssue(6, '2024-04-06T00:00:00Z'),
      makeIssue(5, '2024-04-10T00:00:00Z'),
      makeIssue(4, '2024-04-02T00:00:00Z'),
      makeIssue(3, '2024-04-01T00:00:00Z'),
      makeIssue(2, '2024-04-01T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([6, 5, 2, 3, 4]);
  });

  it('handles issues with missing lastTriaged in secondary bucket', () => {
    const db = makeDb({
      '3': { lastTriaged: '2024-04-03T00:00:00Z' },
      '2': {},
    });
    const issues = [
      makeIssue(3, '2024-04-02T00:00:00Z'),
      makeIssue(2, '2024-04-01T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([2, 3]);
  });

  it('uses lastSeenUpdatedAt instead of lastTriaged when checking for new activity', () => {
    const db = makeDb({
      '8': { lastTriaged: '2024-04-01T00:00:00Z' },
      '7': {
        lastTriaged: '2024-04-10T00:00:00Z',
        lastSeenUpdatedAt: '2024-04-05T00:00:00Z',
      },
    });
    const issues = [
      makeIssue(8, '2024-04-01T00:00:00Z'),
      makeIssue(7, '2024-04-06T00:00:00Z'),
    ];

    expect(buildAutoDiscoverQueue(issues, db)).toEqual([7, 8]);
  });
});

describe('filterPreviouslyTriagedClosedIssuesWithNewActivity', () => {
  it('keeps closed issues triaged before that have newer activity', () => {
    const db = makeDb({
      '1': { lastTriaged: '2024-04-01T00:00:00Z' },
    });
    const closedIssues = [
      makeClosedIssue(1, '2024-04-02T00:00:00Z', '2024-04-03T00:00:00Z'),
    ];

    expect(filterPreviouslyTriagedClosedIssuesWithNewActivity(closedIssues, db).map(issue => issue.number)).toEqual([1]);
  });

  it('drops closed issues that were never triaged', () => {
    const db = makeDb({});
    const closedIssues = [
      makeClosedIssue(2, '2024-04-02T00:00:00Z', '2024-04-03T00:00:00Z'),
    ];

    expect(filterPreviouslyTriagedClosedIssuesWithNewActivity(closedIssues, db)).toEqual([]);
  });

  it('drops closed issues without new activity after close/triage baseline', () => {
    const db = makeDb({
      '3': { lastTriaged: '2024-04-01T00:00:00Z' },
    });
    const closedIssues = [
      makeClosedIssue(3, '2024-04-02T00:00:00Z', '2024-04-02T00:00:00Z'),
    ];

    expect(filterPreviouslyTriagedClosedIssuesWithNewActivity(closedIssues, db)).toEqual([]);
  });

  it('uses lastSeenUpdatedAt when comparing recently closed issues', () => {
    const db = makeDb({
      '6': {
        lastTriaged: '2024-04-10T00:00:00Z',
        lastSeenUpdatedAt: '2024-04-02T12:00:00Z',
      },
    });
    const closedIssues = [
      makeClosedIssue(6, '2024-04-02T00:00:00Z', '2024-04-02T18:00:00Z'),
    ];

    expect(filterPreviouslyTriagedClosedIssuesWithNewActivity(closedIssues, db).map(issue => issue.number)).toEqual([6]);
  });
});
