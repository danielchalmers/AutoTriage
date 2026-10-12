import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeDb, makeEndpoint } from './fixtures';

// src/index.ts wires everything together and starts the run as soon as it is imported, so each test imports a fresh copy with its collaborators mocked.
const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  getConfig: vi.fn(),
  loadDatabase: vi.fn(),
  runAutoTriage: vi.fn(),
  githubArgs: [] as unknown[][],
  chatArgs: [] as unknown[][],
}));

vi.mock('@actions/core', () => ({ setFailed: mocks.setFailed }));
vi.mock('../src/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/env')>()), getConfig: mocks.getConfig }));
vi.mock('../src/storage', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/storage')>()), loadDatabase: mocks.loadDatabase }));
vi.mock('../src/runner', () => ({ runAutoTriage: mocks.runAutoTriage }));
vi.mock('../src/github', () => ({
  GitHubClient: class {
    constructor(...args: unknown[]) {
      mocks.githubArgs.push(args);
    }
  },
}));
vi.mock('../src/llm/chat', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/llm/chat')>()),
  ChatClient: class {
    constructor(...args: unknown[]) {
      mocks.chatArgs.push(args);
    }
  },
}));

const cfg = makeConfig({
  owner: 'octo',
  repo: 'demo',
  token: 'gh-token',
  model: makeEndpoint('test-model', { isDefault: true }),
});
const db = makeDb({ '1': { lastTriaged: '2026-10-01T00:00:00Z' } });

// Process-level handlers are captured instead of installed, so the test worker keeps its own crash handling.
let handlers: Record<string, (...args: any[]) => void>;

async function importEntryPoint() {
  vi.resetModules();
  await import('../src/index');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.githubArgs.length = 0;
  mocks.chatArgs.length = 0;
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
  vi.unstubAllEnvs();
});

describe('AutoTriage action entry point', () => {
  it('builds one model client from config and runs triage with it', async () => {
    await importEntryPoint();

    expect(mocks.loadDatabase).toHaveBeenCalledExactlyOnceWith();
    expect(mocks.githubArgs).toEqual([['gh-token', 'octo', 'demo']]);
    expect(mocks.chatArgs).toEqual([[cfg.model]]);
    expect(mocks.runAutoTriage).toHaveBeenCalledOnce();

    const deps = mocks.runAutoTriage.mock.calls[0]![0];
    expect(deps.cfg).toBe(cfg);
    expect(deps.db).toBe(db);
    expect(deps.model).toBeDefined();
    expect(deps.stats.toJSON()).toMatchObject({ repo: 'octo/demo', model: 'test-model' });
    expect(mocks.setFailed).not.toHaveBeenCalled();
  });

  it('logs the model and host', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await importEntryPoint();

    expect(log).toHaveBeenCalledWith('Model: test-model at api.openai.com (default for OPENAI_API_KEY), reasoning: high.');
  });

  it('fails the action with the stack when the run rejects, which only a bug can cause', async () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'number')");
    mocks.runAutoTriage.mockRejectedValue(error);

    await importEntryPoint();

    await vi.waitFor(() => expect(mocks.setFailed).toHaveBeenCalledWith(error.stack));
  });

  it('fails with the config error alone and does not start a run when the config is invalid', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    mocks.getConfig.mockImplementation(() => {
      throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
    });

    await expect(importEntryPoint()).rejects.toThrow('exit 1');
    expect(mocks.setFailed).toHaveBeenCalledWith('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.runAutoTriage).not.toHaveBeenCalled();
  });

  it('fails as a configuration error and starts no run when the workflow passes a removed input', async () => {
    const { getConfig } = await vi.importActual<typeof import('../src/env')>('../src/env');
    mocks.getConfig.mockImplementation(getConfig);
    vi.stubEnv('INPUT_MODEL-FAST', '');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    await expect(importEntryPoint()).rejects.toThrow('exit 1');
    expect(mocks.setFailed).toHaveBeenCalledExactlyOnceWith(
      'Remove or rename the inputs that AutoTriage no longer takes: model-fast (delete it; v5 reviews every item with model).'
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(mocks.chatArgs).toEqual([]);
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
