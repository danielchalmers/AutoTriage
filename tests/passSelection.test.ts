import { describe, expect, it } from 'vitest';
import { chooseAnalysisPassMode } from '../src/passSelection';

describe('chooseAnalysisPassMode', () => {
  it('uses pro for items that have never been triaged', () => {
    expect(chooseAnalysisPassMode(undefined, Date.parse('2024-04-10T00:00:00Z'), true)).toBe('pro');
  });

  it('uses pro when there is new context since the last triage', () => {
    expect(
      chooseAnalysisPassMode(
        '2024-04-01T00:00:00Z',
        Date.parse('2024-04-10T00:00:00Z'),
        true
      )
    ).toBe('pro');
  });

  it('uses fast for unchanged items that were already triaged', () => {
    expect(
      chooseAnalysisPassMode(
        '2024-04-10T00:00:00Z',
        Date.parse('2024-04-10T00:00:00Z'),
        true
      )
    ).toBe('fast');
  });

  it('falls back to pro when the fast pass is unavailable', () => {
    expect(
      chooseAnalysisPassMode(
        '2024-04-10T00:00:00Z',
        Date.parse('2024-04-10T00:00:00Z'),
        false
      )
    ).toBe('pro');
  });

  it('uses pro when the stored triage timestamp is invalid', () => {
    expect(chooseAnalysisPassMode('not-a-date', Date.parse('2024-04-10T00:00:00Z'), true)).toBe('pro');
  });
});
