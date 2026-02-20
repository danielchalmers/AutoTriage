import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  contextRepo: { owner: 'danielchalmers', repo: 'AutoTriage' },
}));

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
}));

vi.mock('@actions/github', () => ({
  context: {
    get repo() {
      return mocks.contextRepo;
    },
    payload: {},
  },
}));

import { getConfig } from '../src/env';

describe('getConfig extended input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'token';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GITHUB_REPOSITORY = 'danielchalmers/AutoTriage';
    mocks.getInput.mockImplementation((name: string) => {
      if (name === 'extended') return '';
      return '';
    });
  });

  it('defaults to false when input is not set', () => {
    const cfg = getConfig();
    expect(cfg.extended).toBe(false);
  });

  it('parses true when explicitly enabled', () => {
    mocks.getInput.mockImplementation((name: string) => {
      if (name === 'extended') return 'true';
      return '';
    });

    const cfg = getConfig();
    expect(cfg.extended).toBe(true);
  });
});

describe('getConfig renamed inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'token';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GITHUB_REPOSITORY = 'danielchalmers/AutoTriage';
    mocks.getInput.mockImplementation(() => '');
  });

  it('parses dry-run and issues inputs', () => {
    mocks.getInput.mockImplementation((name: string) => {
      if (name === 'dry-run') return 'true';
      if (name === 'issues') return '12, 34';
      return '';
    });

    const cfg = getConfig();
    expect(cfg.dryRun).toBe(true);
    expect(cfg.issueNumbers).toEqual([12, 34]);
  });

  it('uses max-pro-runs', () => {
    mocks.getInput.mockImplementation((name: string) => {
      if (name === 'max-pro-runs') return '7';
      return '';
    });

    const cfg = getConfig();
    expect(cfg.maxProRuns).toBe(7);
  });
});
