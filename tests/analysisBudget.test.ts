import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  getSystemPromptBudgetContentStats,
  getUserPromptBudgetContentStats,
  sumPromptBudgetContentStats,
} from '../src/analysis';
import type { Issue, TimelineEvent } from '../src/github';

const baseIssue: Issue = {
  title: 'Budget test',
  state: 'open',
  type: 'issue',
  number: 42,
  author: 'octocat',
  user_type: 'User',
  draft: false,
  locked: false,
  milestone: null,
  comments: 0,
  reactions: 0,
  labels: [],
  assignees: [],
  body: 'abcdef',
  updated_at: '2024-04-10T00:00:00Z',
  created_at: '2024-04-01T00:00:00Z',
};

describe('budget content stats', () => {
  it('measures system prompt readme content before and after limits', () => {
    const readmePath = path.join(__dirname, 'budget-readme.md');
    fs.writeFileSync(readmePath, 'abcdefghij');

    try {
      expect(getSystemPromptBudgetContentStats(readmePath, { readmeChars: 4 })).toEqual({
        originalChars: 10,
        keptChars: 4,
      });
    } finally {
      fs.unlinkSync(readmePath);
    }
  });

  it('measures issue and timeline content before and after limits', () => {
    const timelineEvents: TimelineEvent[] = [
      { event: 'commented', created_at: '2024-04-01T00:00:00Z', body: 'abcdef' },
      { event: 'commented', created_at: '2024-04-02T00:00:00Z', message: 'ghijkl' },
      { event: 'commented', created_at: '2024-04-03T00:00:00Z', body: 'mnopqr' },
    ];

    const expectedLimitedEvents: TimelineEvent[] = [
      { event: 'commented', created_at: '2024-04-02T00:00:00Z', message: 'ghi' },
      { event: 'commented', created_at: '2024-04-03T00:00:00Z', body: 'mno' },
    ];

    expect(
      getUserPromptBudgetContentStats(baseIssue, timelineEvents, {
        issueBodyChars: 4,
        timelineEvents: 2,
        timelineTextChars: 3,
      })
    ).toEqual({
      originalChars: 6 + JSON.stringify(timelineEvents, null, 2).length,
      keptChars: 4 + JSON.stringify(expectedLimitedEvents, null, 2).length,
    });
  });

  it('sums budget content stats', () => {
    expect(
      sumPromptBudgetContentStats(
        { originalChars: 10, keptChars: 4 },
        { originalChars: 5, keptChars: 3 },
      )
    ).toEqual({
      originalChars: 15,
      keptChars: 7,
    });
  });
});
