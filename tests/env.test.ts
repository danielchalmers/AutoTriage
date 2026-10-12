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
import { REMOVED_INPUTS, describeModel, getConfig } from '../src/env';

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
  // The context reads GITHUB_SHA once, when it's created, so a test run inside GitHub Actions would otherwise see its own commit.
  github.context.sha = '';
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

describe('getConfig removed inputs', () => {
  // GitHub exports every with: key as INPUT_<NAME> with its hyphens kept, even an undeclared one with a blank value.
  it('fails on a removed input even when its value is blank, saying what to do instead', () => {
    vi.stubEnv('INPUT_MODEL-PRO', '');

    expect(() => getConfig()).toThrow('Remove or rename the inputs that AutoTriage no longer takes: model-pro (rename it to model).');
  });

  it('names every removed input it finds, before checking anything else', () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    vi.stubEnv('INPUT_STRICT-MODE', 'true');
    vi.stubEnv('INPUT_MODEL-FAST', 'gemini-3.5-flash-lite');
    vi.stubEnv('INPUT_MAX-FAST-RUNS', '30');

    expect(() => getConfig()).toThrow(
      'Remove or rename the inputs that AutoTriage no longer takes: model-fast (delete it; v5 reviews every item with model), max-fast-runs (delete it), strict-mode (delete it; runs fail only for configuration errors and bugs).'
    );
  });

  it('fails on prompt-path, even set to the old default, because the policy is always read through the API', () => {
    vi.stubEnv('INPUT_PROMPT-PATH', '.github/AutoTriage.prompt');

    expect(() => getConfig()).toThrow(
      'Remove or rename the inputs that AutoTriage no longer takes: prompt-path (delete it; the policy is always .github/AutoTriage.prompt, read through the API at the event commit).'
    );
  });

  it('fails on the backlog and context inputs that are now built in, saying what each became', () => {
    vi.stubEnv('INPUT_EXTENDED', 'true');
    vi.stubEnv('INPUT_MAX-PRO-RUNS', '30');
    vi.stubEnv('INPUT_BUDGET-SCALE', '1');
    vi.stubEnv('INPUT_ADDITIONAL-INSTRUCTIONS', '');
    vi.stubEnv('INPUT_DB-PATH', 'triage-db.json');

    expect(() => getConfig()).toThrow(
      'Remove or rename the inputs that AutoTriage no longer takes: ' +
      'max-pro-runs (delete it; sweeps stop at 30 items and explicit lists run in full), ' +
      'extended (delete it; with a policy file, sweeps revisit unchanged and recently closed items), ' +
      'budget-scale (delete it), ' +
      'additional-instructions (move the text into .github/AutoTriage.prompt), ' +
      'db-path (delete it; the database is always triage-db.json in the working directory, so keep that cache path).'
    );
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

describe('getConfig optional values', () => {
  it('omits optional values that were not provided', () => {
    const cfg = getConfig();

    expect(cfg).not.toHaveProperty('sha');
    expect(cfg).not.toHaveProperty('issueNumbers');
  });

  it('takes the commit to read the policy and README at from the workflow context', () => {
    github.context.sha = '0123456789abcdef0123456789abcdef01234567';

    expect(getConfig().sha).toBe('0123456789abcdef0123456789abcdef01234567');
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

describe('getConfig issues input', () => {
  it('parses issue numbers separated by spaces or commas, with or without #', () => {
    setInputs({ issues: ' 12, #34  56,#78\n90 ' });
    const cfg = getConfig();

    expect(cfg.issueNumbers).toEqual([12, 34, 56, 78, 90]);
  });

  it('parses a single issue as a list of one', () => {
    setInputs({ issues: '#27' });

    expect(getConfig().issueNumbers).toEqual([27]);
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
    setInputs({ model: ' claude-sonnet-5-5 ' });

    expect(getConfig().model).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: 'anthropic-key', isDefault: false });
  });

  it('fails when the model is blank and several keys are set, instead of letting one win', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');

    expect(() => getConfig()).toThrow('Several API keys are set (GEMINI_API_KEY, ANTHROPIC_API_KEY). Set model, or map only one key.');
  });

  it('masks every model API key that is set', () => {
    vi.stubEnv('OPENAI_API_KEY', ' openai-key ');
    setInputs({ model: 'gemini-3.8-flash' });

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

  it('declares none of the removed inputs', () => {
    expect(Object.keys(REMOVED_INPUTS).filter((name) => actionInputs.has(name))).toEqual([]);
  });

  it('documents exactly the declared inputs in the README input table', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const documented = [...readme.matchAll(/^\| `([a-z-]+)` \|/gm)].map(match => match[1]);

    expect(documented.sort()).toEqual([...actionInputs.keys()].sort());
  });
});
