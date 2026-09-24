import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeDb } from './fixtures';

// src/index.ts wires everything together and starts the run as soon as it is imported, so each test imports a fresh copy with its collaborators mocked.
const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  getConfig: vi.fn(),
  loadDatabase: vi.fn(),
  runAutoTriage: vi.fn(),
  githubArgs: [] as unknown[][],
  geminiArgs: [] as unknown[][],
}));

vi.mock('@actions/core', () => ({ setFailed: mocks.setFailed }));
vi.mock('../src/env', () => ({ getConfig: mocks.getConfig }));
vi.mock('../src/storage', () => ({ loadDatabase: mocks.loadDatabase }));
vi.mock('../src/runner', () => ({ runAutoTriage: mocks.runAutoTriage }));
vi.mock('../src/github', () => ({
  GitHubClient: class {
    constructor(...args: unknown[]) {
      mocks.githubArgs.push(args);
    }
  },
}));
vi.mock('../src/gemini', () => ({
  GeminiClient: class {
    constructor(...args: unknown[]) {
      mocks.geminiArgs.push(args);
    }
  },
}));

const cfg = makeConfig({ owner: 'octo', repo: 'demo', token: 'gh-token', geminiApiKey: 'gemini-key', dbPath: 'triage-db.json' });
const db = makeDb({ '1': { summary: 'known' } });

// Process-level handlers are captured instead of installed, so the test worker keeps its own crash handling.
let handlers: Record<string, (...args: any[]) => void>;

async function importEntryPoint() {
  vi.resetModules();
  await import('../src/index');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.githubArgs.length = 0;
  mocks.geminiArgs.length = 0;
  handlers = {};
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: any[]) => void) => {
    handlers[event] = listener;
    return process;
  }) as any);
  mocks.getConfig.mockReturnValue(cfg);
  mocks.loadDatabase.mockReturnValue(db);
  mocks.runAutoTriage.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AutoTriage action entry point', () => {
  it('builds the clients from config and runs triage with them', async () => {
    await importEntryPoint();

    expect(mocks.loadDatabase).toHaveBeenCalledWith('triage-db.json');
    expect(mocks.githubArgs).toEqual([['gh-token', 'octo', 'demo']]);
    expect(mocks.geminiArgs).toEqual([['gemini-key']]);
    expect(mocks.runAutoTriage).toHaveBeenCalledOnce();

    const deps = mocks.runAutoTriage.mock.calls[0]![0];
    expect(deps.cfg).toBe(cfg);
    expect(deps.db).toBe(db);
    expect(deps.stats.toJSON()).toMatchObject({ repo: 'octo/demo', models: { fast: 'fast-model', pro: 'pro-model' } });
    expect(mocks.setFailed).not.toHaveBeenCalled();
  });

  it('fails the action with the stack when the run rejects', async () => {
    const error = new Error('Bad credentials');
    mocks.runAutoTriage.mockRejectedValue(error);

    await importEntryPoint();

    await vi.waitFor(() => expect(mocks.setFailed).toHaveBeenCalledWith(error.stack));
  });

  it('does not start a run when the config is invalid', async () => {
    mocks.getConfig.mockImplementation(() => {
      throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
    });

    // At runtime this throw reaches the uncaughtException handler registered just before it.
    await expect(importEntryPoint()).rejects.toThrow('GITHUB_TOKEN missing');
    expect(handlers.uncaughtException).toBeTypeOf('function');
    expect(mocks.runAutoTriage).not.toHaveBeenCalled();
  });

  it('reports unhandled rejections as failures', async () => {
    await importEntryPoint();

    handlers.unhandledRejection!('socket hang up');

    expect(mocks.setFailed).toHaveBeenCalledWith('Unhandled promise rejection: socket hang up');
  });

  it('reports uncaught exceptions with their stack and exits non-zero', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = new Error('boom');

    await importEntryPoint();
    handlers.uncaughtException!(error);

    expect(mocks.setFailed).toHaveBeenCalledWith(`Uncaught exception: ${error.stack}`);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
