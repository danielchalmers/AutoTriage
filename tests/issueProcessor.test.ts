import { describe, expect, it, vi } from 'vitest';
import { buildRunContext } from '../src/issueProcessor';
import { Issue, TimelineEvent } from '../src/github';

const baseIssue: Issue = {
  title: 'Sample',
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
  body: null,
  updated_at: '2024-04-10T00:00:00Z',
  created_at: '2024-04-01T00:00:00Z',
};

const timelineEvents: TimelineEvent[] = [
  { event: 'commented', created_at: '2024-04-11T00:00:00Z', body: 'Ping' },
];

describe('buildRunContext', () => {
  it('treats items without a previous triage record as a first review', () => {
    const getLastUpdated = vi.fn();

    expect(buildRunContext(baseIssue, timelineEvents, undefined, false, getLastUpdated)).toBe(
      'This item has no previous triage record, so treat this as the first review.'
    );
    expect(getLastUpdated).not.toHaveBeenCalled();
  });

  it('mentions new activity when the item changed after the last triage', () => {
    const getLastUpdated = vi.fn().mockReturnValue(Date.parse('2024-04-11T00:00:00Z'));

    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', true, getLastUpdated)
    ).toContain('it has new activity since then and needs to be re-checked');
  });

  it('explains whether a re-triage came from auto-discovery or explicit workflow selection', () => {
    const getLastUpdated = vi.fn().mockReturnValue(Date.parse('2024-04-09T00:00:00Z'));

    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', true, getLastUpdated)
    ).toContain('it is being revisited during another automated triage sweep');
    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', false, getLastUpdated)
    ).toContain('the workflow explicitly asked for another review');
  });
});
