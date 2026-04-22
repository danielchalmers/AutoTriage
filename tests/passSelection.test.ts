import { describe, expect, it } from 'vitest';
import { selectTriagePassSelection } from '../src/passSelection';

describe('selectTriagePassSelection', () => {
  it('uses pro only for items that have never been triaged', () => {
    expect(selectTriagePassSelection({
      lastTriagedAt: undefined,
      latestUpdateMs: Date.parse('2024-04-05T00:00:00Z'),
      autoDiscover: true,
    })).toEqual({
      strategy: 'pro-only',
      scenario: 'never-triaged',
      hasNewContext: true,
    });
  });

  it('uses pro only when there is new context since the last triage', () => {
    expect(selectTriagePassSelection({
      lastTriagedAt: '2024-04-01T00:00:00Z',
      latestUpdateMs: Date.parse('2024-04-05T00:00:00Z'),
      autoDiscover: true,
    })).toEqual({
      strategy: 'pro-only',
      scenario: 'new-context',
      hasNewContext: true,
    });
  });

  it('uses fast then pro for unchanged extended re-triage', () => {
    expect(selectTriagePassSelection({
      lastTriagedAt: '2024-04-05T00:00:00Z',
      latestUpdateMs: Date.parse('2024-04-05T00:00:00Z'),
      autoDiscover: true,
    })).toEqual({
      strategy: 'fast-then-pro',
      scenario: 'no-new-context-extended',
      hasNewContext: false,
    });
  });

  it('uses pro only for unchanged explicit re-runs', () => {
    expect(selectTriagePassSelection({
      lastTriagedAt: '2024-04-05T00:00:00Z',
      latestUpdateMs: Date.parse('2024-04-05T00:00:00Z'),
      autoDiscover: false,
    })).toEqual({
      strategy: 'pro-only',
      scenario: 'no-new-context-explicit',
      hasNewContext: false,
    });
  });
});
