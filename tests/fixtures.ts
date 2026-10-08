import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
import { Issue } from '../src/github';
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
    strictMode: false,
    ...overrides,
  };
}
