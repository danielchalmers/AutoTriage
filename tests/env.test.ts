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

function setInputs(values: Record<string, string>) {
  mocks.getInput.mockImplementation((name: string) => values[name] ?? '');
}

describe('getConfig boolean inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'token';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GITHUB_REPOSITORY = 'danielchalmers/AutoTriage';
    setInputs({});
  });

  it('defaults booleans to false when inputs are not set', () => {
    const cfg = getConfig();
    expect(cfg.dryRun).toBe(false);
    expect(cfg.contextCaching).toBe(false);
    expect(cfg.extended).toBe(false);
    expect(cfg.strictMode).toBe(false);
  });

  it('parses trimmed true values', () => {
    setInputs({
      'dry-run': ' TRUE ',
      'context-caching': ' true ',
      extended: 'TrUe',
      'strict-mode': ' true ',
    });
    const cfg = getConfig();

    expect(cfg.dryRun).toBe(true);
    expect(cfg.contextCaching).toBe(true);
    expect(cfg.extended).toBe(true);
    expect(cfg.strictMode).toBe(true);
  });
});

describe('getConfig integer and list inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'token';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GITHUB_REPOSITORY = 'danielchalmers/AutoTriage';
    setInputs({});
  });

  it('keeps only positive integer issue numbers', () => {
    setInputs({ issues: '12, 0, -4, nope, 8.5 34' });
    const cfg = getConfig();

    expect(cfg.issueNumbers).toEqual([12, 34]);
    expect(cfg.issueNumber).toBeUndefined();
  });

  it('sets issueNumber when exactly one valid issue remains', () => {
    setInputs({ issues: '0 invalid 27' });
    const cfg = getConfig();

    expect(cfg.issueNumbers).toEqual([27]);
    expect(cfg.issueNumber).toBe(27);
  });

  it('falls back to defaults for invalid positive integer inputs', () => {
    setInputs({
      'max-pro-runs': '0',
      'max-fast-runs': '1.5',
    });

    const cfg = getConfig();

    expect(cfg.maxProRuns).toBe(20);
    expect(cfg.maxFastRuns).toBe(100);
  });

  it('uses provided positive integer run limits', () => {
    setInputs({
      'max-pro-runs': '7',
      'max-fast-runs': '11',
    });

    const cfg = getConfig();

    expect(cfg.maxProRuns).toBe(7);
    expect(cfg.maxFastRuns).toBe(11);
  });
});

describe('getConfig model and budget inputs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'token';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GITHUB_REPOSITORY = 'danielchalmers/AutoTriage';
    setInputs({});
  });

  it('treats blank model-fast input as skip-fast-pass', () => {
    setInputs({ 'model-fast': '   ' });

    const cfg = getConfig();

    expect(cfg.skipFastPass).toBe(true);
    expect(cfg.modelFast).toBe('gemini-3.1-flash-lite-preview');
  });

  it('trims a provided model-fast input', () => {
    setInputs({ 'model-fast': ' fast-model ' });

    const cfg = getConfig();

    expect(cfg.skipFastPass).toBe(false);
    expect(cfg.modelFast).toBe('fast-model');
  });

  it('uses a valid budget scale and falls back for invalid values', () => {
    setInputs({ 'budget-scale': '1.5' });
    const scaled = getConfig();
    expect(scaled.maxFastTimelineEvents).toBe(18);
    expect(scaled.maxProTimelineEvents).toBe(60);

    setInputs({ 'budget-scale': '-2' });
    const fallback = getConfig();
    expect(fallback.maxFastTimelineEvents).toBe(12);
    expect(fallback.maxProTimelineEvents).toBe(40);
  });
});
