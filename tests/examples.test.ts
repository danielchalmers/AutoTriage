import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { REMOVED_INPUTS } from '../src/env';

const root = path.join(__dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('example prompt', () => {
  const example = read('examples/AutoTriage.prompt');
  const repoPrompt = read('.github/AutoTriage.prompt');

  it('leaves out the fixture rules only this repo needs', () => {
    expect(example).not.toMatch(/\[MOCK|mock-fixture|Mock Fixtures|danielchalmers` as a maintainer/i);
  });

  it('is the policy this repo runs, minus its fixture rules', () => {
    expect(repoPrompt).toContain('## Testing and Mock Fixtures');
    const withoutFixtureRules = repoPrompt
      .replace('- First, apply testing and mock-fixture rules when they match.\n', '')
      .replace(/^## Testing and Mock Fixtures\n[\s\S]*?\n(?=## )/m, '');

    expect(withoutFixtureRules).toBe(example);
  });
});

// Each setup is a main workflow plus a signal workflow for pull requests: the examples, and this repo's own pair, which runs the action with uses: ./.
const mainWorkflows = ['examples/workflows/autotriage.yml', '.github/workflows/autotriage.yml'];
const signalWorkflows = ['examples/workflows/autotriage-pr.yml', '.github/workflows/autotriage-pr.yml'];

// The lines under on:, including commented-out triggers.
const triggersOf = (workflow: string) => /^on:\n((?:[ #].*\n|\n)*)/m.exec(workflow)?.[1] ?? '';

// Lists the YAML keys named like a removed input, because GitHub passes every with: key to the action and a removed one fails the run as a configuration error.
const removedInputsIn = (workflow: string) => Object.keys(REMOVED_INPUTS).filter(name => new RegExp(`^ +${name}:`, 'm').test(workflow));

const runsTheActionFromThisRepo = (workflow: string) => /^ +(- )?uses: \.\/$/m.test(workflow);

it('ships exactly one main workflow and one pull request signal as examples', () => {
  expect(fs.readdirSync(path.join(root, 'examples', 'workflows')).sort()).toEqual(['autotriage-pr.yml', 'autotriage.yml']);
});

it('shows both example workflows in the README as they are', () => {
  const yamlBlocks = [...read('README.md').matchAll(/```yaml\n([\s\S]*?)```/g)].map(match => match[1]);
  expect(yamlBlocks).toContain(read('examples/workflows/autotriage.yml'));
  expect(yamlBlocks).toContain(read('examples/workflows/autotriage-pr.yml'));
});

it('covers every workflow in this repo that runs the action', () => {
  const workflowsDir = path.join(root, '.github', 'workflows');
  const running = fs.readdirSync(workflowsDir).filter(file => runsTheActionFromThisRepo(read(`.github/workflows/${file}`)));
  expect(running.sort()).toEqual(['autotriage.yml', 'ci.yml']);
});

describe.each(mainWorkflows)('%s', (file) => {
  const workflow = read(file);
  const triggers = triggersOf(workflow);

  it('triggers on new issues, the signal workflow, a schedule and a manual run, and nothing else', () => {
    expect(triggers).toMatch(/^ {2}issues:\n {4}types: \[opened\]\n/m);
    expect(triggers).toMatch(/^ {2}workflow_run:\n {4}workflows: \[AutoTriage PR\]\n {4}types: \[completed\]\n/m);
    // This repo keeps its schedule commented out.
    expect(triggers).toMatch(/^#? {2}schedule:\n#? {4}- cron: '[^']+'\n/m);
    expect(triggers).toMatch(/^ {2}workflow_dispatch:\n/m);
    expect([...triggers.matchAll(/^ {2}([a-z_]+):/gm)].map(match => match[1])).toEqual(['issues', 'workflow_run', ...(/^ {2}schedule:/m.test(triggers) ? ['schedule'] : []), 'workflow_dispatch']);
  });

  it('triages a workflow_run event only when its signal run succeeded', () => {
    expect(workflow).toContain("\n    if: github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success'\n");
  });

  it('grants the permissions the action writes with', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n {2}issues: write\n {2}pull-requests: write\n/m);
  });

  it('queues runs in one job-level group instead of cancelling them, with a timeout so a hung run cannot hold the queue', () => {
    expect(workflow).not.toMatch(/^concurrency:|cancel-in-progress/m);
    expect(workflow).toMatch(/^ {4}timeout-minutes: \d+\n {4}concurrency:\n {6}group: autotriage\n {6}queue: max\n/m);
  });

  it('takes issues and dry-run from a manual run, which is a dry run unless unticked', () => {
    expect(triggers).toMatch(/^ {6}dry-run:\n {8}description: .*\n {8}type: boolean\n {8}default: true\n/m);
    expect(workflow).toMatch(/^ {10}issues: \$\{\{ inputs\.issues \}\}\n {10}dry-run: \$\{\{ inputs\.dry-run \}\}\n/m);
  });

  it('restores the triage DB on every run but saves it only on schedule and manual runs, which have read-write cache access', () => {
    expect(workflow).not.toContain('actions/cache@');
    expect(workflow).toMatch(/^ {6}- uses: actions\/cache\/restore@\S+$/m);
    expect(/^ {6}- if: (.*)\n {8}uses: actions\/cache\/save@/m.exec(workflow)?.[1]).toBe(
      "always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') && hashFiles('triage-db.json') != ''"
    );
  });

  it('caches the triage DB at triage-db.json, where the action always reads and writes it', () => {
    const cachePaths = [...workflow.matchAll(/uses: actions\/cache\/(?:restore|save)@\S+\n +with:\n +path: (.*)/g)].map(match => match[1]);
    expect(cachePaths.length).toBe(2);
    expect(cachePaths.every(cachePath => cachePath === 'triage-db.json')).toBe(true);
  });

  it('passes no input that AutoTriage removed, and no model, so the key\'s default applies', () => {
    expect(removedInputsIn(workflow)).toEqual([]);
    expect(workflow).not.toMatch(/^ +model:/m);
  });

  it('maps only the Anthropic key, because a blank model with several keys fails the run', () => {
    expect([...workflow.matchAll(/^ +([A-Z_]+_API_KEY|OPENAI_BASE_URL):/gm)].map(match => match[1])).toEqual(['ANTHROPIC_API_KEY']);
  });

  // The action reads the policy and README through the API, so only a workflow that runs this repository's own code with uses: ./ needs a checkout.
  it('checks out the repository only to run the action from it', () => {
    expect(workflow.includes('actions/checkout@')).toBe(runsTheActionFromThisRepo(workflow));
  });
});

it('runs the published action in the example, which needs no checkout', () => {
  const example = read('examples/workflows/autotriage.yml');
  expect(example).toMatch(/^ {6}- uses: danielchalmers\/AutoTriage@v5$/m);
  expect(example).not.toContain('actions/checkout');
  expect(example).toMatch(/^ {2}schedule:\n {4}- cron: '23 8 \* \* \*'\n/m);
});

describe.each(signalWorkflows)('%s', (file) => {
  const workflow = read(file);

  it('runs on opened and ready-for-review pull requests, with no guards', () => {
    expect([...triggersOf(workflow).matchAll(/^ {2}([a-z_]+):/gm)].map(match => match[1])).toEqual(['pull_request']);
    expect(workflow).toMatch(/^ {2}pull_request:\n {4}types: \[opened, ready_for_review\]\n/m);
    expect(workflow).not.toMatch(/^ +if:/m);
  });

  it('gets no permissions or secrets, and only echoes', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('uses:');
    expect([...workflow.matchAll(/^ +- (\w+):/gm)].map(match => match[1])).toEqual(['run']);
    expect(workflow).toMatch(/^ {6}- run: echo "[^"$`]*"$/m);
  });

  it('has the name that its main workflow\'s workflow_run trigger listens for', () => {
    const name = /^name: (.+)$/m.exec(workflow)?.[1];
    const main = read(file.replace(/autotriage-pr\.yml$/, 'autotriage.yml'));
    expect(name).toBe('AutoTriage PR');
    expect(/^ {4}workflows: \[(.+)\]$/m.exec(main)?.[1]).toBe(name);
  });
});

it('runs the example signal workflow unchanged in this repo', () => {
  expect(read('.github/workflows/autotriage-pr.yml')).toBe(read('examples/workflows/autotriage-pr.yml'));
});

it('writes release notes with Nuntia when a release is published, with only the inputs Nuntia takes', () => {
  const nuntia = read('.github/workflows/nuntia.yml');
  expect(triggersOf(nuntia)).toMatch(/^ {2}release:\n {4}types: \[published\]\n {2}workflow_dispatch:\n/m);
  expect(nuntia).toMatch(/^ {6}contents: write\b/m);
  expect([...nuntia.matchAll(/^ {10}([a-z-]+):/gm)].map(match => match[1])).toEqual(['prompt-url']);
  expect([...nuntia.matchAll(/^ +([A-Z_]+_API_KEY):/gm)].map(match => match[1])).toEqual(['ANTHROPIC_API_KEY']);
});

it('runs the unit tests in CI for pull requests to any branch, and cancels only a pull request\'s superseded runs', () => {
  const ci = read('.github/workflows/ci.yml');
  expect(ci).toMatch(/^ {2}pull_request:\n {4}branches: \["\*\*"\]\n/m);
  expect(ci).toMatch(/^ {8}run: npm run verify$/m);
  expect(ci).toContain('group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}');
});

it('passes no input that AutoTriage removed to the CI mock triage', () => {
  expect(removedInputsIn(read('.github/workflows/ci.yml'))).toEqual([]);
});
