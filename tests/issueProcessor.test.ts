import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicClient } from '../src/llm/anthropic';
import { GeminiClient } from '../src/llm/gemini';
import { ModelError } from '../src/llm/types';
import { buildRunContext, processIssue } from '../src/issueProcessor';
import type { Config } from '../src/config';
import { RunStatistics } from '../src/stats';
import type { TriageDb } from '../src/storage';
import { TimelineEvent } from '../src/github';
import { buildAutoDiscoverQueue } from '../src/autoDiscover';
import { bothPasses, makeConfig, makeIssue, withArtifactsDir } from './fixtures';

const baseIssue = makeIssue(42, '2024-04-10T00:00:00Z', { created_at: '2024-04-01T00:00:00Z' });

const timelineEvents: TimelineEvent[] = [
  { event: 'commented', created_at: '2024-04-11T00:00:00Z', body: 'Ping' },
];

describe('buildRunContext', () => {
  it('treats items without a previous triage record as a first review', () => {
    const getLastUpdated = vi.fn();

    expect(buildRunContext(baseIssue, timelineEvents, undefined, false, getLastUpdated)).toBe(
      'This item has no previous triage record, so treat this as the first review.'
    );
    expect(getLastUpdated).not.toHaveBeenCalled();
  });

  it('mentions new activity when the item changed after the last triage', () => {
    const getLastUpdated = vi.fn().mockReturnValue(Date.parse('2024-04-11T00:00:00Z'));

    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', true, getLastUpdated)
    ).toContain('it has new activity since then and needs to be re-checked');
  });

  it('explains whether a re-triage came from auto-discovery or explicit workflow selection', () => {
    const getLastUpdated = vi.fn().mockReturnValue(Date.parse('2024-04-09T00:00:00Z'));

    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', true, getLastUpdated)
    ).toContain('it is being revisited during another automated triage sweep');
    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', false, getLastUpdated)
    ).toContain('the workflow explicitly asked for another review');
  });
});

function createConfig(overrides: Partial<Config> = {}): Config {
  return makeConfig({
    promptPath: '',
    readmePath: '',
    limits: {
      fast: { readmeChars: 0, issueBodyChars: 5000, timelineEvents: 5, timelineTextChars: 5000 },
      pro: { readmeChars: 0, issueBodyChars: 5000, timelineEvents: 10, timelineTextChars: 5000 },
    },
    ...overrides,
  });
}

// The timeline read is identical across these tests; only the write methods and model replies vary.
function createGitHub(overrides: Record<string, unknown> = {}) {
  return {
    listTimelineEvents: vi.fn().mockResolvedValue({ raw: timelineEvents, filtered: timelineEvents }),
    lastUpdated: vi.fn().mockReturnValue(Date.parse('2024-04-11T00:00:00Z')),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    createComment: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    updateIssueState: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function processOptions(overrides: Record<string, unknown> = {}) {
  return {
    issue: baseIssue,
    repoLabels: [{ name: 'bug' }],
    autoDiscover: false,
    systemPromptFast: 'fast system prompt',
    systemPromptPro: 'pro system prompt',
    cacheInfos: new Map(),
    runTimestamp: '2026-05-19T16:16:13.737Z',
    ...overrides,
  };
}

function modelReply(summary: string, thoughts: string, operations: unknown[], tokens: number) {
  return {
    data: { summary, operations },
    thoughts,
    inputTokens: tokens,
    cachedInputTokens: 0,
    outputTokens: tokens / 2,
  };
}

const addBugLabel = (authorization: string) => ({ kind: 'add_labels', labels: ['bug'], authorization });

describe('processIssue', () => {
  it('skips the pro pass when the fast pass plans no operations', async () => {
    await withArtifactsDir(async (tempDir) => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub();
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Fast summary', 'Fast thoughts', [], 10)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig(), db, gh, models: bothPasses(model), stats },
        processOptions()
      );

      expect(result).toEqual({ triageUsed: false, fastRunUsed: true });
      expect(model.generateJson).toHaveBeenCalledTimes(1);
      expect(db.items['42']).toMatchObject({
        summary: 'Fast summary',
        lastSeenUpdatedAt: '2024-04-10T00:00:00Z',
      });

      const item = (stats.toJSON() as any).items.find((i: any) => i.number === 42);
      expect(item).toMatchObject({
        agreement: 'fast-noop',
        fastPlan: { kinds: [], labels: [] },
      });

      const files = fs.readdirSync(path.join(tempDir, 'artifacts')).sort();
      expect(files).toContain('42-fast-analysis.json');
      expect(files).toContain('42-prompt-fast-user.md');
      expect(files).toContain('42-timeline.json');
      expect(files).not.toContain('42-operations.json');
      expect(files).not.toContain('42-prompt-user.md');
    });
  });

  it('runs the pro pass and executes planned operations after the fast pass', async () => {
    await withArtifactsDir(async (tempDir) => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({
        getIssue: vi.fn()
          .mockResolvedValueOnce(baseIssue)
          .mockResolvedValueOnce({ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }),
      });
      const model = {
        generateJson: vi
          .fn()
          .mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10))
          .mockResolvedValueOnce(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig({ dryRun: false }), db, gh, models: bothPasses(model), stats },
        processOptions()
      );

      expect(result).toEqual({ triageUsed: true, fastRunUsed: true });
      expect(model.generateJson).toHaveBeenCalledTimes(2);
      expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);

      const item = (stats.toJSON() as any).items.find((i: any) => i.number === 42);
      expect(item).toMatchObject({
        agreement: 'identical',
        fastPlan: { kinds: ['add_labels'], labels: ['+bug'] },
        proPlan: { kinds: ['add_labels'], labels: ['+bug'] },
      });
      expect(gh.getIssue).toHaveBeenCalledWith(42);
      expect(db.items['42']).toMatchObject({
        summary: 'Pro summary',
        lastSeenUpdatedAt: '2024-04-12T00:00:00Z',
      });

      const artifactsDir = path.join(tempDir, 'artifacts');
      const files = fs.readdirSync(artifactsDir).sort();
      expect(files).toContain('42-fast-analysis.json');
      expect(files).toContain('42-prompt-fast-user.md');
      expect(files).toContain('42-pro-analysis.json');
      expect(files).toContain('42-prompt-user.md');
      expect(files).toContain('42-operations.json');
      expect(fs.readFileSync(path.join(artifactsDir, '42-operations.json'), 'utf8')).toContain('"kind": "add_labels"');
    });
  });

  it('records a pro veto without touching GitHub when the pro pass rejects the fast plan', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn() });
      const model = {
        generateJson: vi
          .fn()
          .mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10))
          .mockResolvedValueOnce(modelReply('Pro summary', 'Pro thoughts', [], 20)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig({ dryRun: false }), db, gh, models: bothPasses(model), stats },
        processOptions()
      );

      expect(result).toEqual({ triageUsed: true, fastRunUsed: true });
      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(db.items['42']).toMatchObject({ summary: 'Pro summary', lastSeenUpdatedAt: '2024-04-10T00:00:00Z' });
      const item = (stats.toJSON() as any).items.find((i: any) => i.number === 42);
      expect(item).toMatchObject({ outcome: 'triaged', agreement: 'pro-vetoed', proPlan: { kinds: [], labels: [] } });
    });
  });

  it('sends each pass to its own client and model, uses the cached flex tier when cached, and hands the fast plan to the pro pass', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub();
      // model-fast and model-pro can be served by different providers.
      const fast = { generateJson: vi.fn().mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10)) } as any;
      const pro = { generateJson: vi.fn().mockResolvedValueOnce(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)) } as any;

      await processIssue(
        { cfg: createConfig(), db, gh, models: { fast, pro }, stats },
        processOptions({ cacheInfos: new Map([['pro', { name: 'cachedContents/pro', tokenCount: 100 }]]) })
      );

      expect(fast.generateJson).toHaveBeenCalledOnce();
      expect(pro.generateJson).toHaveBeenCalledOnce();
      const [fastRequest] = fast.generateJson.mock.calls[0];
      expect(fastRequest).toMatchObject({ model: 'fast-model', systemPrompt: 'fast system prompt', cacheName: undefined, useFlexTier: false });

      const [proRequest] = pro.generateJson.mock.calls[0];
      expect(proRequest).toMatchObject({ model: 'pro-model', systemPrompt: 'pro system prompt', cacheName: 'cachedContents/pro', useFlexTier: true });
      const proUserPrompt = proRequest.userPrompt;
      expect(proUserPrompt).toContain('=== SECTION: FAST PASS PROPOSED PLAN (JSON) ===');
      expect(proUserPrompt).toContain('"authorization": "fast policy"');
    });
  });

  it('defers operations and retains the analyzed watermark when the thread changes during analysis', async () => {
    await withArtifactsDir(async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({
        getIssue: vi.fn().mockResolvedValue({ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }),
      });
      const model = {
        generateJson: vi
          .fn()
          .mockResolvedValue(modelReply('Pro summary', 'Pro thoughts', [{
            kind: 'set_state',
            state: 'not_planned',
            authorization: 'pro policy',
          }], 20)),
      } as any;

      try {
        const result = await processIssue(
          { cfg: createConfig({ dryRun: false, skipFastPass: true }), db, gh, models: bothPasses(model), stats },
          processOptions({ systemPromptFast: '' })
        );

        expect(result).toEqual({ triageUsed: true, fastRunUsed: false });
        expect(gh.updateIssueState).not.toHaveBeenCalled();
        expect(gh.getIssue).toHaveBeenCalledWith(42);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(db.items['42']).toBeUndefined();
        expect(buildAutoDiscoverQueue([{ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }], db, true)).toEqual([42]);
        expect((stats.toJSON() as any).items).toContainEqual(expect.objectContaining({
          outcome: 'skipped',
          skipReason: 'deferred',
        }));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('defers operations without updating the database when the pre-write recheck fails', async () => {
    await withArtifactsDir(async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const db: TriageDb = {
        version: 2,
        items: {
          '42': {
            lastTriaged: '2024-04-05T00:00:00Z',
            lastSeenUpdatedAt: '2024-04-05T00:00:00Z',
            summary: 'Previous summary',
          },
        },
      };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn().mockRejectedValue(new Error('recheck failed')) });
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      try {
        await processIssue(
          { cfg: createConfig({ dryRun: false, skipFastPass: true }), db, gh, models: bothPasses(model), stats },
          processOptions({ systemPromptFast: '' })
        );

        expect(gh.addLabels).not.toHaveBeenCalled();
        expect(db.items['42']).toEqual({
          lastTriaged: '2024-04-05T00:00:00Z',
          lastSeenUpdatedAt: '2024-04-05T00:00:00Z',
          summary: 'Previous summary',
        });
        expect(buildAutoDiscoverQueue([baseIssue], db, true)).toEqual([42]);
        expect((stats.toJSON() as any).items).toContainEqual(expect.objectContaining({
          outcome: 'skipped',
          skipReason: 'deferred',
        }));
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('uses the analyzed watermark when the post-action refresh fails', async () => {
    await withArtifactsDir(async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({
        getIssue: vi.fn()
          .mockResolvedValueOnce(baseIssue)
          .mockRejectedValueOnce(new Error('refresh failed')),
      });
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      try {
        await processIssue(
          { cfg: createConfig({ dryRun: false, skipFastPass: true }), db, gh, models: bothPasses(model), stats },
          processOptions({ systemPromptFast: '' })
        );

        expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
        expect(db.items['42']).toMatchObject({
          summary: 'Pro summary',
          lastSeenUpdatedAt: '2024-04-10T00:00:00Z',
        });
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('does not recheck before executing a dry-run plan', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn() });
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      await processIssue(
        { cfg: createConfig({ dryRun: true, skipFastPass: true }), db, gh, models: bothPasses(model), stats },
        processOptions({ systemPromptFast: '' })
      );

      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
    });
  });

  it('retries a model reply without an operations array and falls back to the title for a non-string summary', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const replies = ['{"summary":"s","operations":{}}', '{"summary":7,"operations":[]}'];
      const fetch = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: replies.shift() }] } }] }));
      const model = new GeminiClient('test-key', fetch);
      vi.spyOn(model as any, 'sleep').mockResolvedValue(undefined);

      await processIssue({ cfg: createConfig(), db, gh: createGitHub(), models: bothPasses(model), stats }, processOptions());

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(db.items['42']).toMatchObject({ summary: baseIssue.title });
    });
  });

  it('escalates to the pro pass without a fast plan when the fast model refuses', async () => {
    await withArtifactsDir(async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const model = {
        generateJson: vi
          .fn()
          .mockRejectedValueOnce(new ModelError('Gemini declined to answer (finishReason SAFETY)', { kind: 'refusal' }))
          .mockResolvedValueOnce(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      const result = await processIssue({ cfg: createConfig(), db, gh: createGitHub(), models: bothPasses(model), stats }, processOptions());

      expect(result).toEqual({ triageUsed: true, fastRunUsed: true });
      expect(model.generateJson).toHaveBeenCalledTimes(2);
      expect(model.generateJson.mock.calls[1][0].userPrompt).not.toContain('FAST PASS PROPOSED PLAN');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('The fast model refused #42'));
      const item = (stats.toJSON() as any).items.find((i: any) => i.number === 42);
      expect(item).toMatchObject({ outcome: 'triaged', escalatedToPro: true, proPlan: { kinds: ['add_labels'], labels: ['+bug'] } });
      expect(item.fastPlan).toBeUndefined();
      expect(item.agreement).toBeUndefined();
      expect(db.items['42']).toMatchObject({ summary: 'Pro summary' });
    });
  });

  it('records a pro-pass refusal as skipped and consumes its watermark so it is not re-billed', async () => {
    await withArtifactsDir(async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn() });
      const model = {
        generateJson: vi
          .fn()
          .mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10))
          .mockRejectedValueOnce(new ModelError('Gemini blocked the prompt (blockReason PROHIBITED_CONTENT)', { kind: 'refusal' })),
      } as any;

      const result = await processIssue({ cfg: createConfig({ dryRun: false }), db, gh, models: bothPasses(model), stats }, processOptions());

      expect(result).toEqual({ triageUsed: true, fastRunUsed: true });
      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(db.items['42']).toMatchObject({ summary: baseIssue.title, lastSeenUpdatedAt: '2024-04-10T00:00:00Z' });
      const item = (stats.toJSON() as any).items.find((i: any) => i.number === 42);
      expect(item).toMatchObject({ outcome: 'skipped', skipReason: 'refused', escalatedToPro: true, fastPlan: { kinds: ['add_labels'], labels: ['+bug'] } });
      expect(item.proPlan).toBeUndefined();
      // An unchanged item is left out of the next sweep's queue.
      expect(buildAutoDiscoverQueue([baseIssue], db, true)).toEqual([]);
    });
  });

  it('fails the item without retrying when the reply is truncated', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const fetch = vi.fn(async () => Response.json({ candidates: [{ content: { parts: [{ text: '{"summary":"cut' }] }, finishReason: 'MAX_TOKENS' }] }));
      const model = new GeminiClient('test-key', fetch);
      vi.spyOn(model as any, 'sleep').mockResolvedValue(undefined);

      const error = await processIssue(
        { cfg: createConfig({ skipFastPass: true }), db, gh: createGitHub(), models: bothPasses(model), stats: new RunStatistics() },
        processOptions()
      ).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).failure).toEqual({ kind: 'truncated' });
      expect(fetch).toHaveBeenCalledOnce();
      expect(db.items['42']).toBeUndefined();
    });
  });

  it('triages through Claude with the system prompt marked for caching, and counts its cache writes as created', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const bodies: any[] = [];
      const reply = (operations: unknown[], usage: Record<string, number>) => Response.json({
        content: [{ type: 'thinking', thinking: 'Looks like a bug.', signature: 'sig' }, { type: 'text', text: JSON.stringify({ summary: 'Crash', operations }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 50, output_tokens: 80, output_tokens_details: { thinking_tokens: 60 }, ...usage },
      });
      const replies = [
        reply([addBugLabel('fast policy')], { cache_creation_input_tokens: 1000 }),
        reply([addBugLabel('pro policy')], { cache_creation_input_tokens: 3000 }),
      ];
      const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return replies.shift()!;
      });
      const model = new AnthropicClient('test-key', fetch);
      const cacheInfos = new Map([
        ['fast', await model.createCache('fast-model', 'fast system prompt')],
        ['pro', await model.createCache('pro-model', 'pro system prompt')],
      ]);

      await processIssue(
        { cfg: createConfig(), db, gh: createGitHub(), models: bothPasses(model), stats },
        processOptions({ cacheInfos })
      );

      expect(fetch).toHaveBeenCalledTimes(2);
      for (const body of bodies) {
        expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(body.output_config.format.schema.properties.operations.items.anyOf[0].properties.labels.items).toEqual({ type: 'string', enum: ['bug'] });
      }
      const json = stats.toJSON() as any;
      expect(json.fast).toMatchObject({ runs: 1, inputTokens: 1050, thoughtsTokens: 60, outputTokens: 20, cacheCreatedTokens: 1000 });
      expect(json.pro).toMatchObject({ runs: 1, inputTokens: 3050, cacheCreatedTokens: 3000 });
      expect(db.items['42']).toMatchObject({ summary: 'Crash' });
    });
  });

  it('marks the pass in flight so a thrown error can be attributed', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub();
      const model = {
        generateJson: vi
          .fn()
          // Fast pass escalates, then the pro pass dies.
          .mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10))
          .mockRejectedValueOnce(new Error('503 UNAVAILABLE')),
      } as any;

      await expect(
        processIssue({ cfg: createConfig(), db, gh, models: bothPasses(model), stats }, processOptions())
      ).rejects.toThrow('503');
      expect(stats.getCurrentPass()).toBe('pro');
    });
  });
});
