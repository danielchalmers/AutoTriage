import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_TOKEN', 'token');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  vi.stubEnv('GITHUB_REPOSITORY', 'danielchalmers/AutoTriage');
  setInputs({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getConfig required context', () => {
  it.each([
    ['GITHUB_TOKEN', /GITHUB_TOKEN missing/],
    ['GEMINI_API_KEY', /GEMINI_API_KEY missing/],
  ])('fails fast when %s is not set', (name, expected) => {
    vi.stubEnv(name, '');

    expect(() => getConfig()).toThrow(expected);
  });

});

describe('getConfig path and text inputs', () => {
  it('omits optional values that were not provided', () => {
    const cfg = getConfig();

    expect(cfg.promptPath).toBe('.github/AutoTriage.prompt');
    expect(cfg).not.toHaveProperty('dbPath');
    expect(cfg).not.toHaveProperty('additionalInstructions');
    expect(cfg).not.toHaveProperty('issueNumbers');
    expect(cfg).not.toHaveProperty('issueNumber');
  });

  it('trims provided paths and instructions', () => {
    setInputs({
      'prompt-path': ' .github/triage.prompt ',
      'db-path': ' triage-db.json ',
      'additional-instructions': '  Only label bugs.  ',
    });

    expect(getConfig()).toMatchObject({
      promptPath: '.github/triage.prompt',
      dbPath: 'triage-db.json',
      additionalInstructions: 'Only label bugs.',
    });
  });
});

describe('getConfig boolean inputs', () => {
  it('defaults booleans to false when inputs are not set', () => {
    const cfg = getConfig();
    expect(cfg.dryRun).toBe(false);
    expect(cfg.extended).toBe(false);
    expect(cfg.strictMode).toBe(false);
  });

  it('parses trimmed true values', () => {
    setInputs({
      'dry-run': ' TRUE ',
      extended: 'TrUe',
      'strict-mode': ' true ',
    });
    const cfg = getConfig();

    expect(cfg.dryRun).toBe(true);
    expect(cfg.extended).toBe(true);
    expect(cfg.strictMode).toBe(true);
  });
});

describe('getConfig integer and list inputs', () => {
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

describe('getConfig model inputs', () => {
  it('treats blank model-fast input as skip-fast-pass', () => {
    setInputs({ 'model-fast': '   ' });

    const cfg = getConfig();

    expect(cfg.skipFastPass).toBe(true);
    expect(cfg.modelFast).toBe('');
  });

  it('trims a provided model-fast input', () => {
    setInputs({ 'model-fast': ' fast-model ' });

    const cfg = getConfig();

    expect(cfg.skipFastPass).toBe(false);
    expect(cfg.modelFast).toBe('fast-model');
  });

  it('defaults the pro model to flash-lite', () => {
    const cfg = getConfig();

    expect(cfg.modelPro).toBe('gemini-3.5-flash-lite');
  });

  it('scales every limit by budget-scale and allows 0 to disable context', () => {
    setInputs({ 'budget-scale': '0' });

    expect(getConfig().limits).toEqual({
      fast: { readmeChars: 0, issueBodyChars: 0, timelineEvents: 0, timelineTextChars: 0 },
      pro: { readmeChars: 0, issueBodyChars: 0, timelineEvents: 0, timelineTextChars: 0 },
    });
  });

  it('uses a valid budget scale and falls back for invalid values', () => {
    setInputs({ 'budget-scale': '1.5' });
    const scaled = getConfig();
    expect(scaled.limits.fast.timelineEvents).toBe(18);
    expect(scaled.limits.pro.timelineEvents).toBe(60);

    setInputs({ 'budget-scale': '-2' });
    const fallback = getConfig();
    expect(fallback.limits.fast.timelineEvents).toBe(12);
    expect(fallback.limits.pro.timelineEvents).toBe(40);

    setInputs({ 'budget-scale': 'lots' });
    expect(getConfig().limits.pro.timelineEvents).toBe(40);
  });

  it('always uses README.md for README context', () => {
    setInputs({ 'readme-path': 'docs/README.md' });

    const cfg = getConfig();

    expect(cfg.readmePath).toBe('README.md');
  });
});

// action.yml is the public contract; these keep it, getConfig, and the README input table from drifting apart.
describe('action.yml input contract', () => {
  const root = path.join(__dirname, '..');

  function readActionInputs(): Map<string, string | undefined> {
    const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    const inputsBlock = actionYml.split(/^inputs:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
    const inputs = new Map<string, string | undefined>();
    for (const block of inputsBlock.split(/^(?=  [a-z-]+:\s*$)/m)) {
      const name = block.match(/^  ([a-z-]+):\s*$/m)?.[1];
      if (!name) continue;
      inputs.set(name, block.match(/^    default:\s*"(.*)"\s*$/m)?.[1]);
    }
    return inputs;
  }

  const actionInputs = readActionInputs();

  it('parses the declared inputs', () => {
    expect(actionInputs.size).toBeGreaterThan(0);
  });

  it('reads every declared input and no undeclared ones', () => {
    getConfig();

    const readInputs = new Set(mocks.getInput.mock.calls.map(([name]) => name as string));
    expect([...readInputs].sort()).toEqual([...actionInputs.keys()].sort());
  });

  it('declares defaults that match the defaults getConfig applies to blank inputs', () => {
    const fromBlank = getConfig();

    const defaults = Object.fromEntries([...actionInputs].filter(([, value]) => value !== undefined)) as Record<string, string>;
    setInputs(defaults);

    expect(getConfig()).toEqual(fromBlank);
  });

  it('documents exactly the declared inputs in the README input table', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const documented = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1]);

    expect(documented.sort()).toEqual([...actionInputs.keys()].sort());
  });
});
