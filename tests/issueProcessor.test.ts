import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { buildAnalysisResultSchema } from '../src/analysis';
import { ChatClient, ModelError } from '../src/llm/chat';
import { PassError, buildRunContext, processIssue } from '../src/issueProcessor';
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
  const NEW_ACTIVITY = 'it has new activity since then and needs to be re-checked';

  it('treats items without a previous triage record as a first review', () => {
    expect(buildRunContext(baseIssue, timelineEvents, undefined, false)).toBe(
      'This item has no previous triage record, so treat this as the first review.'
    );
  });

  it('mentions new activity when a timeline event is newer than the last triage', () => {
    expect(buildRunContext(baseIssue, timelineEvents, '2024-04-10T00:00:00Z', true)).toContain(NEW_ACTIVITY);
  });

  it("counts the item's own update time, and ignores undated timeline events", () => {
    const events: TimelineEvent[] = [...timelineEvents, { event: 'committed' }];

    expect(buildRunContext({ ...baseIssue, updated_at: '2024-04-13T00:00:00Z' }, events, '2024-04-12T00:00:00Z', true)).toContain(NEW_ACTIVITY);
    expect(buildRunContext(baseIssue, events, '2024-04-12T00:00:00Z', true)).not.toContain(NEW_ACTIVITY);
  });

  it('explains whether a re-triage came from auto-discovery or explicit workflow selection', () => {
    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-12T00:00:00Z', true)
    ).toContain('it is being revisited during another automated triage sweep');
    expect(
      buildRunContext(baseIssue, timelineEvents, '2024-04-12T00:00:00Z', false)
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
    schema: buildAnalysisResultSchema([{ name: 'bug' }]),
    autoDiscover: false,
    systemPromptFast: 'fast system prompt',
    systemPromptPro: 'pro system prompt',
    runTimestamp: '2026-05-19T16:16:13.737Z',
    ...overrides,
  };
}

function modelReply(summary: string, operations: unknown[], tokens: number) {
  return {
    data: { summary, operations },
    inputTokens: tokens,
    cachedInputTokens: 0,
    outputTokens: tokens / 2,
    reasoningTokens: 0,
  };
}

const OPENAI = { baseUrl: 'https://api.openai.com/v1', host: 'api.openai.com', apiKey: 'test-key', keyName: 'OPENAI_API_KEY' };

// A Chat Completions reply for each request in turn, recording the request bodies.
function chatFetch(...contents: Array<string | Record<string, unknown>>) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const next = contents.shift();
    const choice = typeof next === 'string' ? { message: { role: 'assistant', content: next }, finish_reason: 'stop' } : next;
    return Response.json({ choices: [choice], usage: { prompt_tokens: 3050, completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 60 } } });
  });
  return Object.assign(fetch, { bodies });
}

const addBugLabel = (authorization: string) => ({ kind: 'add_labels', labels: ['bug'], authorization });

describe('processIssue', () => {
  it('skips the pro pass when the fast pass plans no operations', async () => {
    await withArtifactsDir(async (tempDir) => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub();
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Fast summary', [], 10)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig(), db, gh, models: bothPasses(model), stats },
        processOptions()
      );

      expect(result).toEqual({
        issueNumber: 42,
        type: 'issue',
        title: 'Sample',
        outcome: 'skipped',
        escalatedToPro: false,
        fastPlan: { kinds: [], labels: [] },
        agreement: 'fast-noop',
      });
      expect(model.generateJson).toHaveBeenCalledTimes(1);
      expect(db.items['42']).toMatchObject({
        summary: 'Fast summary',
        lastSeenUpdatedAt: '2024-04-10T00:00:00Z',
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
          .mockResolvedValueOnce(modelReply('Fast summary', [addBugLabel('fast policy')], 10))
          .mockResolvedValueOnce(modelReply('Pro summary', [addBugLabel('pro policy')], 20)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig({ dryRun: false }), db, gh, models: bothPasses(model), stats },
        processOptions()
      );

      expect(result).toEqual({
        issueNumber: 42,
        type: 'issue',
        title: 'Sample',
        outcome: 'triaged',
        escalatedToPro: true,
        fastPlan: { kinds: ['add_labels'], labels: ['+bug'] },
        proPlan: { kinds: ['add_labels'], labels: ['+bug'] },
        agreement: 'identical',
      });
      expect(model.generateJson).toHaveBeenCalledTimes(2);
      expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
      expect((stats.toJSON() as any).actions).toEqual({ total: 1, byKind: { add_labels: 1 } });
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
          .mockResolvedValueOnce(modelReply('Fast summary', [addBugLabel('fast policy')], 10))
          .mockResolvedValueOnce(modelReply('Pro summary', [], 20)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig({ dryRun: false }), db, gh, models: bothPasses(model), stats },
        processOptions()
      );

      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(db.items['42']).toMatchObject({ summary: 'Pro summary', lastSeenUpdatedAt: '2024-04-10T00:00:00Z' });
      expect(result).toMatchObject({ outcome: 'triaged', escalatedToPro: true, agreement: 'pro-vetoed', proPlan: { kinds: [], labels: [] } });
    });
  });

  it('sends each pass to its own client and model, and hands the fast plan to the pro pass', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub();
      // model-fast and model-pro can be served by different providers.
      const fast = { generateJson: vi.fn().mockResolvedValueOnce(modelReply('Fast summary', [addBugLabel('fast policy')], 10)) } as any;
      const pro = { generateJson: vi.fn().mockResolvedValueOnce(modelReply('Pro summary', [addBugLabel('pro policy')], 20)) } as any;

      await processIssue(
        { cfg: createConfig(), db, gh, models: { fast, pro }, stats },
        processOptions()
      );

      expect(fast.generateJson).toHaveBeenCalledOnce();
      expect(pro.generateJson).toHaveBeenCalledOnce();
      const [fastRequest] = fast.generateJson.mock.calls[0];
      expect(fastRequest).toMatchObject({ model: 'fast-model', systemPrompt: 'fast system prompt' });

      const [proRequest] = pro.generateJson.mock.calls[0];
      expect(proRequest).toMatchObject({ model: 'pro-model', systemPrompt: 'pro system prompt' });
      const proUserPrompt = proRequest.userPrompt;
      expect(proUserPrompt).toContain('=== SECTION: FAST PASS PROPOSED PLAN (JSON) ===');
      expect(proUserPrompt).toContain('"authorization": "fast policy"');
    });
  });

  it('defers operations, logs them and retains the analyzed watermark when the thread changes during analysis', async () => {
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
          .mockResolvedValue(modelReply('Pro summary', [{
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

        // The review pass ran, so the item counts as escalated even without a fast pass.
        expect(result).toEqual({
          issueNumber: 42,
          type: 'issue',
          title: 'Sample',
          outcome: 'deferred',
          escalatedToPro: true,
          changedDuringAnalysis: true,
          proPlan: { kinds: ['set_state'], labels: [] },
          detail: "It changed while it was being analyzed, so the plan wasn't applied.",
        });
        expect(gh.updateIssueState).not.toHaveBeenCalled();
        expect(gh.getIssue).toHaveBeenCalledWith(42);
        expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
          '⚠️ #42 changed while it was being analyzed (updated at 2024-04-10T00:00:00Z, now 2024-04-12T00:00:00Z). Deferring its planned operations: state: not_planned.'
        );
        expect(db.items['42']).toBeUndefined();
        expect(buildAutoDiscoverQueue([{ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }], db, true)).toEqual([42]);
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
        generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', [addBugLabel('pro policy')], 20)),
      } as any;

      try {
        const result = await processIssue(
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
        expect(result).toMatchObject({
          outcome: 'deferred',
          escalatedToPro: true,
          detail: "It couldn't be rechecked before applying the plan, so the plan wasn't applied: recheck failed",
        });
        // Only an item that changed is analyzed again.
        expect(result).not.toHaveProperty('changedDuringAnalysis');
        expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
          '⚠️ Failed to recheck #42 before applying operations: recheck failed. Deferring its planned operations: labels: +bug.'
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('marks a re-analysis in its log group and record, and says when the item changed again', async () => {
    await withArtifactsDir(async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const renamed = { ...baseIssue, title: 'Renamed', updated_at: '2024-04-12T00:00:00Z' };
      const model = { generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', [addBugLabel('pro policy')], 20)) } as any;
      const reanalyze = async (current: typeof renamed) => {
        const gh = createGitHub({ getIssue: vi.fn().mockResolvedValue(current) });
        const result = await processIssue(
          { cfg: createConfig({ dryRun: false, skipFastPass: true }), db: { version: 2, items: {} }, gh, models: bothPasses(model), stats: new RunStatistics() },
          processOptions({ issue: renamed, systemPromptFast: '', reanalysis: true })
        );
        return { result, gh };
      };

      try {
        const applied = await reanalyze(renamed);
        expect(applied.result).toMatchObject({ title: 'Renamed', outcome: 'triaged', reanalyzed: true });
        expect(applied.gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
        expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('::group::🤖 #42 Renamed (re-analysis)'));

        const changedAgain = await reanalyze({ ...renamed, updated_at: '2024-04-13T00:00:00Z' });
        expect(changedAgain.result).toMatchObject({
          outcome: 'deferred',
          reanalyzed: true,
          changedDuringAnalysis: true,
          detail: "It changed again while it was being re-analyzed, so the plan wasn't applied.",
        });
        expect(changedAgain.gh.addLabels).not.toHaveBeenCalled();
      } finally {
        stdoutSpy.mockRestore();
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
        generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', [addBugLabel('pro policy')], 20)),
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
        generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', [addBugLabel('pro policy')], 20)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig({ dryRun: true, skipFastPass: true }), db, gh, models: bothPasses(model), stats },
        processOptions({ systemPromptFast: '' })
      );

      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(result).toEqual({
        issueNumber: 42,
        type: 'issue',
        title: 'Sample',
        outcome: 'triaged',
        escalatedToPro: true,
        proPlan: { kinds: ['add_labels'], labels: ['+bug'] },
      });
    });
  });

  it('retries a model reply without an operations array and falls back to the title for a non-string summary', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const fetch = chatFetch('{"summary":"s","operations":{}}', '{"summary":7,"operations":[]}');
      const model = new ChatClient(OPENAI, fetch);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(model as any, 'sleep').mockResolvedValue(undefined);

      await processIssue({ cfg: createConfig(), db, gh: createGitHub(), models: bothPasses(model), stats }, processOptions());

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(db.items['42']).toMatchObject({ summary: baseIssue.title });
    });
  });

  it('fails the item without retrying when the reply is cut off', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const fetch = chatFetch({ message: { role: 'assistant', content: '{"summary":"cut' }, finish_reason: 'length' });
      const model = new ChatClient(OPENAI, fetch);

      const error = await processIssue(
        { cfg: createConfig({ skipFastPass: true }), db, gh: createGitHub(), models: bothPasses(model), stats: new RunStatistics() },
        processOptions()
      ).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PassError);
      expect(error).toMatchObject({ pass: 'pro', message: 'api.openai.com stopped the reply at the output token limit' });
      expect((error as PassError).cause).toBeInstanceOf(ModelError);
      expect((error as PassError).cause).toMatchObject({ kind: 'permanent' });
      expect(fetch).toHaveBeenCalledOnce();
      expect(db.items['42']).toBeUndefined();
    });
  });

  it('triages through Chat Completions, and explains the plan in the log and the comment', async () => {
    await withArtifactsDir(async (tempDir) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn().mockResolvedValue(baseIssue) });
      const operations = [
        addBugLabel('Policy 2 labels crashes as bugs'),
        { kind: 'comment', body: 'Thanks for the report.', authorization: 'Policy 4 thanks first-time reporters' },
      ];
      const fetch = chatFetch(JSON.stringify({ summary: 'Crash on save', operations }));

      try {
        await processIssue(
          { cfg: createConfig({ dryRun: false, skipFastPass: true }), db, gh, models: bothPasses(new ChatClient(OPENAI, fetch)), stats },
          processOptions({ systemPromptFast: '' })
        );

        const explanation = [
          'Summary: Crash on save',
          'Operations:',
          '- add_labels: Policy 2 labels crashes as bugs',
          '- comment: Policy 4 thanks first-time reporters',
        ].join('\n');
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.bodies[0].messages[0]).toEqual({ role: 'system', content: 'pro system prompt' });
        expect(fetch.bodies[0].response_format.json_schema.schema.properties.operations.items.anyOf[0].properties.labels.items).toEqual({ type: 'string', enum: ['bug'] });
        expect(log.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringContaining(explanation));
        expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
        expect(gh.createComment).toHaveBeenCalledWith(42, `Thanks for the report.\n\n<!--\n${explanation}\n-->`);
        expect((stats.toJSON() as any).pro).toMatchObject({ runs: 1, inputTokens: 3050, outputTokens: 20, reasoningTokens: 60 });
        expect(db.items['42']).toMatchObject({ summary: 'Crash on save' });
        // The raw artifact keeps what the model actually returned.
        const artifact = JSON.parse(fs.readFileSync(path.join(tempDir, 'artifacts', '42-pro-analysis.json'), 'utf8'));
        expect(artifact).toEqual({ summary: 'Crash on save', operations });
      } finally {
        log.mockRestore();
      }
    });
  });

  it('rethrows a failed pass with the pass attached', async () => {
    await withArtifactsDir(async () => {
      const unavailable = new ModelError('503 UNAVAILABLE', 'capacity');
      const failFast = { generateJson: vi.fn().mockRejectedValueOnce(unavailable) } as any;
      const failPro = {
        generateJson: vi
          .fn()
          // Fast pass escalates, then the pro pass dies.
          .mockResolvedValueOnce(modelReply('Fast summary', [addBugLabel('fast policy')], 10))
          .mockRejectedValueOnce(unavailable),
      } as any;
      const run = (model: any) => processIssue(
        { cfg: createConfig(), db: { version: 2, items: {} }, gh: createGitHub(), models: bothPasses(model), stats: new RunStatistics() },
        processOptions()
      ).catch((err: unknown) => err);

      expect(await run(failFast)).toMatchObject({ pass: 'fast', cause: unavailable, message: '503 UNAVAILABLE' });
      expect(await run(failPro)).toMatchObject({ pass: 'pro', cause: unavailable });
    });
  });

  it('attributes a failed GitHub write to the review pass, and leaves a failed timeline read unattributed', async () => {
    await withArtifactsDir(async () => {
      const writeError = new Error('HTTP 500');
      const readError = new Error('HTTP 502');
      const model = { generateJson: vi.fn().mockResolvedValue(modelReply('Pro summary', [addBugLabel('pro policy')], 20)) } as any;
      const run = (gh: ReturnType<typeof createGitHub>) => processIssue(
        { cfg: createConfig({ dryRun: false, skipFastPass: true }), db: { version: 2, items: {} }, gh, models: bothPasses(model), stats: new RunStatistics() },
        processOptions({ systemPromptFast: '' })
      ).catch((err: unknown) => err);

      const writeFailure = await run(createGitHub({ getIssue: vi.fn().mockResolvedValue(baseIssue), addLabels: vi.fn().mockRejectedValue(writeError) }));
      expect(writeFailure).toBeInstanceOf(PassError);
      expect(writeFailure).toMatchObject({ pass: 'pro', cause: writeError });

      expect(await run(createGitHub({ listTimelineEvents: vi.fn().mockRejectedValue(readError) }))).toBe(readError);
    });
  });
});
