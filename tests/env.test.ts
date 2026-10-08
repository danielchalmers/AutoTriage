import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('@actions/core', () => ({
  getInput: mocks.getInput,
  setSecret: mocks.setSecret,
}));

// @actions/github is deliberately not mocked: its context.repo reads GITHUB_REPOSITORY on each access (falling back to the event payload), so these tests exercise the real resolution and error behavior.

import * as github from '@actions/github';
import { describeModels, getConfig } from '../src/env';

function setInputs(values: Record<string, string>) {
  mocks.getInput.mockImplementation((name: string) => values[name] ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_TOKEN', 'token');
  vi.stubEnv('GEMINI_API_KEY', 'gemini-key');
  // The other model variables are cleared so the developer's own environment can't change which provider is picked.
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
  vi.stubEnv('GITHUB_REPOSITORY', 'danielchalmers/AutoTriage');
  // On GitHub Actions the context loads the triggering event's payload at import; clear it so it can't stand in for GITHUB_REPOSITORY.
  github.context.payload = {};
  setInputs({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getConfig required context', () => {
  it('fails fast when GITHUB_TOKEN is not set', () => {
    vi.stubEnv('GITHUB_TOKEN', '');

    expect(() => getConfig()).toThrow(/GITHUB_TOKEN missing/);
  });

  it('fails fast when no model API key is set, naming every key it accepts', () => {
    vi.stubEnv('GEMINI_API_KEY', '');

    expect(() => getConfig()).toThrow('model-pro is blank and no model API key is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY');
  });

  it('checks GITHUB_TOKEN before the model keys', () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('GEMINI_API_KEY', '');

    expect(() => getConfig()).toThrow(/GITHUB_TOKEN missing/);
  });

});

describe('getConfig repository context', () => {
  it('uses the repository the workflow runs in', () => {
    expect(getConfig()).toMatchObject({ owner: 'danielchalmers', repo: 'AutoTriage' });
  });

  it('falls back to the event payload repository when GITHUB_REPOSITORY is unset', () => {
    vi.stubEnv('GITHUB_REPOSITORY', '');
    github.context.payload = { repository: { name: 'payload-repo', owner: { login: 'payload-owner' } } } as any;

    expect(getConfig()).toMatchObject({ owner: 'payload-owner', repo: 'payload-repo' });
  });

  it.each([
    ['is not set', ''],
    ['has no repository part', 'danielchalmers'],
  ])('fails with an actionable message when GITHUB_REPOSITORY %s', (_label, value) => {
    vi.stubEnv('GITHUB_REPOSITORY', value);

    expect(() => getConfig()).toThrow('Failed to resolve repository context (owner/repo).');
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
    expect(cfg.models).toEqual({
      fast: null,
      pro: expect.objectContaining({ provider: 'gemini', model: 'gemini-3.5-flash-lite', tier: 'official', apiKey: 'gemini-key', isDefault: true }),
    });
  });

  it.each([
    ['ANTHROPIC_API_KEY', 'anthropic', 'claude-haiku-5-5'],
    ['OPENAI_API_KEY', 'openai', 'gpt-6-luna'],
  ])('defaults the pro model to the default for %s when it is the only key', (key, provider, model) => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv(key, 'other-key');

    const cfg = getConfig();

    expect(cfg.modelPro).toBe(model);
    expect(cfg.models.pro).toMatchObject({ provider, model, tier: 'official', apiKey: 'other-key' });
  });

  it('resolves each pass on its own, sending the bare model ID', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    setInputs({ 'model-fast': ' anthropic/claude-haiku-5-5 ', 'model-pro': 'gemini/gemini-3.8-flash' });

    const cfg = getConfig();

    expect(cfg).toMatchObject({ skipFastPass: false, modelFast: 'claude-haiku-5-5', modelPro: 'gemini-3.8-flash' });
    expect(cfg.models.fast).toMatchObject({ provider: 'anthropic', apiKey: 'anthropic-key' });
    expect(cfg.models.pro).toMatchObject({ provider: 'gemini', apiKey: 'gemini-key' });
  });

  it('fails at startup when a model needs a key that is not set', () => {
    setInputs({ 'model-fast': 'claude-haiku-5-5' });

    expect(() => getConfig()).toThrow('model-fast "claude-haiku-5-5" is served by anthropic, which needs ANTHROPIC_API_KEY');
  });

  it('masks every model API key that is set', () => {
    vi.stubEnv('OPENAI_API_KEY', ' openai-key ');

    getConfig();

    expect(mocks.setSecret.mock.calls).toEqual([['gemini-key'], ['openai-key']]);
  });

  it('describes which provider serves each pass and why', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http://localhost:11434/v1');
    setInputs({ 'model-fast': 'llama3:8b' });

    expect(describeModels(getConfig().models)).toEqual([
      'Model (fast): llama3:8b via openai at localhost:11434 [best effort] — set by model-fast; sent to OPENAI_BASE_URL.',
      'Model (pro): gemini-3.5-flash-lite via gemini [official] — default for GEMINI_API_KEY; set model-pro to change.',
    ]);
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
