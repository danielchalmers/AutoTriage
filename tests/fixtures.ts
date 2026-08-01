import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
import { Issue } from '../src/github';
import { TriageDb } from '../src/storage';
import type { Config } from '../src/config';

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

// Materializes files on disk for the duration of fn; prompt loading reads real paths.
export function withTempFiles<T>(files: Record<string, string>, fn: () => T): T {
  for (const [filePath, contents] of Object.entries(files)) {
    fs.writeFileSync(filePath, contents);
  }
  try {
    return fn();
  } finally {
    for (const filePath of Object.keys(files)) {
      fs.unlinkSync(filePath);
    }
  }
}

// Mirrors the production defaults so a new Config field only has to be added here.
export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    owner: 'owner',
    repo: 'repo',
    token: 'token',
    geminiApiKey: 'key',
    dryRun: true,
    promptPath: 'examples/AutoTriage.prompt',
    readmePath: 'README.md',
    skipFastPass: false,
    modelFast: 'fast-model',
    modelPro: 'pro-model',
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
