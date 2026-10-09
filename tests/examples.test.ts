import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

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
    if (!workflow.includes('db-path')) {
      expect(workflow).not.toContain('triage-db.json');
    }
  });

  it('leaves prompt-path and the triggering item at their defaults', () => {
    expect(workflow).not.toContain('prompt-path');
    expect(workflow).not.toMatch(/issues: \$\{\{ github\.event\.(issue|pull_request)\./);
  });
});

it('keeps the quick start in dry-run until the user has reviewed a plan', () => {
  expect(quickStart).toContain('dry-run: "true"');
});
