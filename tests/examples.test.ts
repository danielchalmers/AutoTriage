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

const readme = read('README.md');
const quickStart = /```yaml\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf('## Quick start')))?.[1] ?? '';

const workflowFiles = [
  ...fs.readdirSync(path.join(root, 'examples', 'workflows')).map(file => `examples/workflows/${file}`),
  '.github/workflows/issues.yml',
  '.github/workflows/prs.yml',
  '.github/workflows/comments.yml',
  '.github/workflows/backlog.yml',
];

const triageWorkflows: Array<[string, string]> = [
  ['README.md quick start', quickStart],
  ...workflowFiles.map((file): [string, string] => [file, read(file)]),
];

// Lists the YAML keys named like a removed input, because GitHub passes every with: key to the action and a removed one fails the run as a configuration error.
const removedInputsIn = (workflow: string) => Object.keys(REMOVED_INPUTS).filter(name => new RegExp(`^ +${name}:`, 'm').test(workflow));

describe.each(triageWorkflows)('%s', (_name, workflow) => {
  it('grants the permissions the action writes with', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n {2}issues: write\n {2}pull-requests: write\n/m);
  });

  it('queues runs in one job-level group instead of cancelling them, with a timeout so a hung run cannot hold the queue', () => {
    expect(workflow).not.toMatch(/^concurrency:|cancel-in-progress/m);
    expect(workflow).toMatch(/^ {4}timeout-minutes: \d+\n {4}concurrency:\n {6}group: autotriage\n {6}queue: max\n/m);
  });

  it('saves and uploads the triage DB only where the run can use it', () => {
    const triggers = /^on:\n((?:[ #].*\n|\n)*)/m.exec(workflow)?.[1] ?? '';
    expect(triggers).not.toBe('');
    expect(workflow).not.toContain('actions/cache@');
    if (/^ {2}(issues|pull_request_target|issue_comment):/m.test(triggers)) {
      expect(workflow).not.toContain('actions/cache/save');
    }
  });

  it('caches the triage DB at triage-db.json, where the action always reads and writes it', () => {
    const cachePaths = [...workflow.matchAll(/uses: actions\/cache\/(?:restore|save)@\S+\n +with:\n +path: (.*)/g)].map(match => match[1]);
    expect(cachePaths.length).toBe((workflow.match(/actions\/cache\//g) ?? []).length);
    expect(cachePaths.every(cachePath => cachePath === 'triage-db.json')).toBe(true);
  });

  it('passes no input that AutoTriage removed', () => {
    expect(removedInputsIn(workflow)).toEqual([]);
  });

  it('leaves the triggering item at its default', () => {
    expect(workflow).not.toMatch(/issues: \$\{\{ github\.event\.(issue|pull_request)\./);
  });

  // The action reads the policy and README through the API, so only a workflow that runs this repository's own code with uses: ./ needs a checkout.
  it('checks out the repository only to run the action from it', () => {
    expect(workflow.includes('actions/checkout@')).toBe(/^ +(- )?uses: \.\/$/m.test(workflow));
  });
});

it('keeps the quick start in dry-run until the user has reviewed a plan', () => {
  expect(quickStart).toContain('dry-run: "true"');
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
