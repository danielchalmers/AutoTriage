import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConfig, makeDb, makeResolvedModel } from './fixtures';

// src/index.ts wires everything together and starts the run as soon as it is imported, so each test imports a fresh copy with its collaborators mocked.
const mocks = vi.hoisted(() => ({
  setFailed: vi.fn(),
  getConfig: vi.fn(),
  loadDatabase: vi.fn(),
  runAutoTriage: vi.fn(),
  githubArgs: [] as unknown[][],
  geminiArgs: [] as unknown[][],
  anthropicArgs: [] as unknown[][],
  openaiArgs: [] as unknown[][],
}));

vi.mock('@actions/core', () => ({ setFailed: mocks.setFailed }));
vi.mock('../src/env', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/env')>()), getConfig: mocks.getConfig }));
vi.mock('../src/storage', () => ({ loadDatabase: mocks.loadDatabase }));
vi.mock('../src/runner', () => ({ runAutoTriage: mocks.runAutoTriage }));
vi.mock('../src/github', () => ({
  GitHubClient: class {
    constructor(...args: unknown[]) {
      mocks.githubArgs.push(args);
    }
  },
}));
vi.mock('../src/llm/gemini', () => ({
  GeminiClient: class {
    constructor(...args: unknown[]) {
      mocks.geminiArgs.push(args);
    }
  },
}));
vi.mock('../src/llm/anthropic', () => ({
  AnthropicClient: class {
    constructor(...args: unknown[]) {
      mocks.anthropicArgs.push(args);
    }
  },
}));
vi.mock('../src/llm/openai', () => ({
  OpenAIClient: class {
    constructor(...args: unknown[]) {
      mocks.openaiArgs.push(args);
    }
  },
}));

const cfg = makeConfig({
  owner: 'octo',
  repo: 'demo',
  token: 'gh-token',
  dbPath: 'triage-db.json',
  models: {
    fast: makeResolvedModel('fast-model', { apiKey: 'gemini-key', reason: 'set by model-fast' }),
    pro: makeResolvedModel('pro-model', { apiKey: 'gemini-key', tier: 'official', reason: 'default for GEMINI_API_KEY', isDefault: true }),
  },
});
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
  mocks.anthropicArgs.length = 0;
  mocks.openaiArgs.length = 0;
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
    // Both passes use Gemini, so they share one client.
    expect(deps.models.pro).toBeDefined();
    expect(deps.models.fast).toBe(deps.models.pro);
    expect(deps.stats.toJSON()).toMatchObject({
      repo: 'octo/demo',
      models: { fast: 'fast-model', pro: 'pro-model' },
      providers: { fast: { provider: 'gemini', tier: 'best-effort' }, pro: { provider: 'gemini', tier: 'official' } },
    });
    expect(mocks.setFailed).not.toHaveBeenCalled();
  });

  it('logs which provider serves each pass', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await importEntryPoint();

    expect(log).toHaveBeenCalledWith('Model (fast): fast-model via gemini [best effort] — set by model-fast.');
    expect(log).toHaveBeenCalledWith('Model (pro): pro-model via gemini [official] — default for GEMINI_API_KEY; set model-pro to change.');
  });

  it('gives a skipped fast pass the pro client and records no fast provider', async () => {
    mocks.getConfig.mockReturnValue({ ...cfg, skipFastPass: true, modelFast: '', models: { fast: null, pro: cfg.models.pro } });

    await importEntryPoint();

    const deps = mocks.runAutoTriage.mock.calls[0]![0];
    expect(deps.models.fast).toBe(deps.models.pro);
    expect(deps.stats.toJSON().providers).toEqual({ fast: null, pro: { provider: 'gemini', tier: 'official' } });
  });

  it('gives each pass the client for its provider, with that provider key and base URL', async () => {
    const pro = makeResolvedModel('claude-haiku-5-5', { provider: 'anthropic', apiKey: 'anthropic-key', baseUrl: 'https://api.anthropic.com', host: 'api.anthropic.com' });
    mocks.getConfig.mockReturnValue({ ...cfg, modelPro: 'claude-haiku-5-5', models: { fast: cfg.models.fast, pro } });

    await importEntryPoint();

    expect(mocks.geminiArgs).toEqual([['gemini-key']]);
    expect(mocks.anthropicArgs).toEqual([['anthropic-key', expect.any(Function), 'https://api.anthropic.com']]);
    const deps = mocks.runAutoTriage.mock.calls[0]![0];
    expect(deps.models.fast).not.toBe(deps.models.pro);
    expect(deps.stats.toJSON().providers).toEqual({ fast: { provider: 'gemini', tier: 'best-effort' }, pro: { provider: 'anthropic', tier: 'best-effort' } });
  });

  it('gives an OpenAI-compatible endpoint the Chat Completions client with its base URL, and no key when none is set', async () => {
    const pro = makeResolvedModel('llama4', { provider: 'openai', apiKey: undefined, baseUrl: 'http://localhost:11434/v1', host: 'localhost:11434' });
    mocks.getConfig.mockReturnValue({ ...cfg, skipFastPass: true, modelFast: '', modelPro: 'llama4', models: { fast: null, pro } });

    await importEntryPoint();

    expect(mocks.geminiArgs).toEqual([]);
    expect(mocks.openaiArgs).toEqual([[undefined, expect.any(Function), 'http://localhost:11434/v1']]);
    expect(mocks.runAutoTriage).toHaveBeenCalledOnce();
  });

  it('fails the action with the stack when the run rejects', async () => {
    const error = new Error('Bad credentials');
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
