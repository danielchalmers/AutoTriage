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
import { describeModel, getConfig } from '../src/env';

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
  vi.stubEnv('GITHUB_REPOSITORY', 'danielchalmers/AutoTriage');
  // The fallback test below gives the context a payload, so every test starts without one.
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

    expect(() => getConfig()).toThrow('No model API key is set. Add GEMINI_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY');
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
  it('defaults dry-run to false when it is not set', () => {
    expect(getConfig().dryRun).toBe(false);
  });

  it('keeps the default for a blank value, as a workflow expression can produce', () => {
    setInputs({ 'dry-run': '   ' });

    expect(getConfig().dryRun).toBe(false);
  });

  it.each(['true', 'True', 'TRUE', ' true '])('parses %j as true', (value) => {
    setInputs({ 'dry-run': value });

    expect(getConfig().dryRun).toBe(true);
  });

  it.each(['false', 'False', 'FALSE'])('parses %j as false', (value) => {
    setInputs({ 'dry-run': value });

    expect(getConfig().dryRun).toBe(false);
  });

  it.each(['yes', 'no', 'on', '1', 'TrUe'])('fails on dry-run %j instead of running live', (value) => {
    setInputs({ 'dry-run': value });

    expect(() => getConfig()).toThrow(`The dry-run input must be true or false, not '${value}'.`);
  });
});

describe('getConfig integer and list inputs', () => {
  it('parses issue numbers separated by spaces or commas, with or without #', () => {
    setInputs({ issues: ' 12, #34  56,#78\n90 ' });
    const cfg = getConfig();

    expect(cfg.issueNumbers).toEqual([12, 34, 56, 78, 90]);
    expect(cfg.issueNumber).toBeUndefined();
  });

  it('sets issueNumber for a single issue', () => {
    setInputs({ issues: '#27' });
    const cfg = getConfig();

    expect(cfg.issueNumbers).toEqual([27]);
    expect(cfg.issueNumber).toBe(27);
  });

  it('triages a repeated issue number once', () => {
    setInputs({ issues: '12 #12, 34' });

    expect(getConfig().issueNumbers).toEqual([12, 34]);
  });

  it('fails on tokens that are not issue numbers, naming each one, instead of sweeping the backlog', () => {
    setInputs({ issues: '12, 0, -4, nope, 8.5 #, 34' });

    expect(() => getConfig()).toThrow(`The issues input takes issue or PR numbers separated by spaces or commas, such as "12, #34", but got '0', '-4', 'nope', '8.5', '#'.`);
  });

  it('fails on a value with only separators', () => {
    setInputs({ issues: ' , ' });

    expect(() => getConfig()).toThrow("but got ','.");
  });

  it('fails on a number too large to be exact', () => {
    setInputs({ issues: '9007199254740993' });

    expect(() => getConfig()).toThrow("but got '9007199254740993'.");
  });

  it('caps a run at 50 analyses by default', () => {
    expect(getConfig().maxRuns).toBe(50);
  });

  it.each(['0', '-3', '1.5', 'lots'])('falls back to the default for max-runs %j', (value) => {
    setInputs({ 'max-runs': value });

    expect(getConfig().maxRuns).toBe(50);
  });

  it('uses a provided positive max-runs', () => {
    setInputs({ 'max-runs': ' 7 ' });

    expect(getConfig().maxRuns).toBe(7);
  });
});

describe('getConfig model input', () => {
  it('defaults to flash-lite for a Gemini key', () => {
    expect(getConfig().model).toEqual(
      expect.objectContaining({ provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'gemini-key', isDefault: true })
    );
  });

  it.each([
    ['ANTHROPIC_API_KEY', 'anthropic', 'claude-haiku-5-5'],
    ['OPENAI_API_KEY', 'openai', 'gpt-6-luna'],
  ])('defaults to the default for %s when it is the only key', (key, provider, model) => {
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv(key, 'other-key');

    expect(getConfig().model).toMatchObject({ provider, model, apiKey: 'other-key', isDefault: true });
  });

  it('trims a provided model and routes it by name', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
    setInputs({ model: ' claude-haiku-5-5 ' });

    expect(getConfig().model).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'anthropic-key', isDefault: false });
  });

  it('masks every model API key that is set', () => {
    vi.stubEnv('OPENAI_API_KEY', ' openai-key ');
    setInputs({ model: 'gemini-3.5-flash-lite' });

    getConfig();

    expect(mocks.setSecret.mock.calls).toEqual([['gemini-key'], ['openai-key']]);
  });

  it('describes the model, the host and the reasoning setting', () => {
    expect(describeModel(getConfig().model)).toBe(
      'Model: gemini-3.5-flash-lite at generativelanguage.googleapis.com (default for GEMINI_API_KEY), reasoning: high.'
    );

    vi.stubEnv('OPENAI_BASE_URL', 'http://localhost:11434/v1');
    setInputs({ model: 'llama3:8b' });
    expect(describeModel(getConfig().model)).toBe('Model: llama3:8b at localhost:11434, reasoning: high if localhost:11434 honors reasoning_effort.');
  });

  it('fails when model is blank and several API keys are set, instead of picking one', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');

    expect(() => getConfig()).toThrow('Several API keys are set (GEMINI_API_KEY, ANTHROPIC_API_KEY). Set model, or map only one key.');
  });

  it('scales every limit by budget-scale and allows 0 to disable context', () => {
    setInputs({ 'budget-scale': '0' });

    expect(getConfig().limits).toEqual({ readmeChars: 0, issueBodyChars: 0, timelineEvents: 0, timelineTextChars: 0 });
  });

  it('uses a valid budget scale and falls back for invalid values', () => {
    expect(getConfig().limits).toEqual({ readmeChars: 120000, issueBodyChars: 20000, timelineEvents: 40, timelineTextChars: 4000 });

    setInputs({ 'budget-scale': '1.5' });
    expect(getConfig().limits.timelineEvents).toBe(60);

    setInputs({ 'budget-scale': '-2' });
    expect(getConfig().limits.timelineEvents).toBe(40);

    setInputs({ 'budget-scale': 'lots' });
    expect(getConfig().limits.timelineEvents).toBe(40);
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
