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

describe('getConfig scan-recently-closed input', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'token';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GITHUB_REPOSITORY = 'danielchalmers/AutoTriage';
    mocks.getInput.mockImplementation((name: string) => {
      if (name === 'scan-recently-closed') return '';
      return '';
    });
  });

  it('defaults to true when input is not set', () => {
    const cfg = getConfig();
    expect(cfg.scanRecentlyClosed).toBe(true);
  });

  it('parses false when explicitly disabled', () => {
    mocks.getInput.mockImplementation((name: string) => {
      if (name === 'scan-recently-closed') return 'false';
      return '';
    });

    const cfg = getConfig();
    expect(cfg.scanRecentlyClosed).toBe(false);
  });
});
