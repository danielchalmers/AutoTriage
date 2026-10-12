import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
import { Issue, PullRequestSummary } from '../src/github';
import type { TriggerEvent } from '../src/event';
import { TriageDb } from '../src/storage';
import type { Config } from '../src/config';
import type { Endpoint } from '../src/llm/endpoint';
import type { ModelClients } from '../src/issueProcessor';

export const baseIssue: Omit<Issue, 'number' | 'updated_at' | 'created_at'> = {
  title: 'Sample',
  state: 'open',
  type: 'issue',
  author: 'octocat',
  user_type: 'User',
  draft: false,
  locked: false,
  milestone: null,
  comments: 0,
  reactions: 0,
  labels: [],
  assignees: [],
  body: null,
};

// Omitting updatedAt leaves created_at/updated_at unset, which is what prompt-shape tests want.
export function makeIssue(number: number, updatedAt?: string, overrides: Partial<Issue> = {}): Issue {
  return {
    ...baseIssue,
    number,
    ...(updatedAt ? { updated_at: updatedAt, created_at: updatedAt } : {}),
    ...overrides,
  };
}

export function makeClosedIssue(number: number, closedAt: string, updatedAt: string): Issue {
  return {
    ...makeIssue(number, updatedAt),
    state: 'closed',
    closed_at: closedAt,
  };
}

export function makeDb(items: TriageDb['items'] = {}): TriageDb {
  return {
    version: 2,
    items,
  };
}

// Runs fn against a throwaway directory and removes it even when the assertion fails.
export async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Same, but also points process.cwd() at the directory so artifact writes land inside it.
export async function withArtifactsDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  return withTempDir(async (dir) => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      return await fn(dir);
    } finally {
      cwdSpy.mockRestore();
    }
  });
}

// Materializes files in a throwaway directory for the duration of fn, since prompt loading reads real paths.
// fn receives a resolver from file name to its path in that directory.
export function withTempFiles<T>(files: Record<string, string>, fn: (file: (name: string) => string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-'));
  try {
    for (const [name, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), contents);
    }
    return fn(name => path.join(dir, name));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// An OpenAI endpoint, as getConfig resolves it with only OPENAI_API_KEY set.
export function makeEndpoint(model: string, overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    provider: 'openai',
    model,
    baseUrl: 'https://api.openai.com/v1',
    host: 'api.openai.com',
    apiKey: 'key',
    keyName: 'OPENAI_API_KEY',
    isDefault: false,
    ...overrides,
  };
}

// The same client for both passes.
export function bothPasses(model: unknown): ModelClients {
  return { fast: model, pro: model } as ModelClients;
}

// Mirrors the production defaults so a new Config field only has to be added here.
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'owner',
    repo: 'repo',
    token: 'token',
    dryRun: true,
    // Absolute, so tests that point process.cwd() at a temp directory still load the example prompt.
    promptPath: path.join(__dirname, '..', 'examples', 'AutoTriage.prompt'),
    readmePath: 'README.md',
    skipFastPass: false,
    modelFast: 'fast-model',
    modelPro: 'pro-model',
    models: { fast: makeEndpoint('fast-model'), pro: makeEndpoint('pro-model') },
    limits: {
      fast: { readmeChars: 0, issueBodyChars: 4000, timelineEvents: 12, timelineTextChars: 600 },
      pro: { readmeChars: 120000, issueBodyChars: 20000, timelineEvents: 40, timelineTextChars: 4000 },
    },
    maxProRuns: 20,
    maxFastRuns: 100,
    extended: false,
    ...overrides,
  };
}

// Shaped like the RequestError Octokit throws, which tests/failures.test.ts checks against the real one.
export function githubError(status: number, message: string, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { name: 'HttpError', status, response: { status, headers, data: { message } } });
}

// This repository's id, as GitHub puts it on a workflow_run event and on the base of each pull request listed there.
export const REPOSITORY_ID = 1001;

/**
 * A workflow_run event as GitHub sends it when a fork's pull request signal workflow completes, trimmed to the fields around the ones AutoTriage reads.
 * A fork's run lists no pull requests, and its display title is the PR's title, which AutoTriage must never trust.
 */
export function makeWorkflowRunEvent(run: Record<string, unknown> = {}): TriggerEvent {
  return {
    name: 'workflow_run',
    payload: {
      action: 'completed',
      repository: { id: REPOSITORY_ID, name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' } },
      workflow_run: {
        id: 9001,
        name: 'AutoTriage PR',
        event: 'pull_request',
        status: 'completed',
        conclusion: 'success',
        display_title: 'Fix typo (and triage #1 instead)',
        head_branch: 'fix-typo',
        head_sha: 'abc123',
        created_at: '2026-10-11T12:00:30Z',
        updated_at: '2026-10-11T12:01:10Z',
        pull_requests: [],
        repository: { id: REPOSITORY_ID, name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' } },
        head_repository: { id: 2002, name: 'repo', full_name: 'pat/repo', owner: { login: 'pat' } },
        ...run,
      },
    },
  };
}

// The same event for a same-repository pull request, which GitHub lists on the run.
export function makeSameRepoWorkflowRunEvent(prNumber: number, run: Record<string, unknown> = {}): TriggerEvent {
  const repo = { id: REPOSITORY_ID, name: 'repo', url: 'https://api.github.com/repos/owner/repo' };
  return makeWorkflowRunEvent({
    head_repository: { id: REPOSITORY_ID, name: 'repo', full_name: 'owner/repo', owner: { login: 'owner' } },
    pull_requests: [{ id: 5001, number: prNumber, head: { ref: 'fix-typo', sha: 'abc123', repo }, base: { ref: 'main', sha: 'def456', repo } }],
    ...run,
  });
}

// An open pull request opened 30 seconds before the trigger run above was created.
export function makePullRequest(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return { number, state: 'open', draft: false, created_at: '2026-10-11T12:00:00Z', head_sha: 'abc123', ...overrides };
}
