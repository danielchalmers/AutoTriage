import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

// core.group writes ::group:: commands straight to stdout, which a passing test can't keep quiet, so here it only runs the item.
vi.mock('@actions/core', async (importActual) => ({
  ...(await importActual<typeof import('@actions/core')>()),
  group: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));

import * as core from '@actions/core';
import { buildAnalysisResultSchema } from '../src/analysis';
import { ChatClient, ModelError } from '../src/llm/chat';
import { buildRunContext, processIssue } from '../src/issueProcessor';
import { TIMELINE_EVENTS } from '../src/prompts';
import { RunStatistics } from '../src/stats';
import type { TriageDb } from '../src/storage';
import { TimelineEvent } from '../src/github';
import { buildAutoDiscoverQueue } from '../src/autoDiscover';
import { githubError, makeConfig, makeIssue, withArtifactsDir } from './fixtures';

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
    systemPrompt: 'system prompt',
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
  it('analyzes the item once with the run\'s model and system prompt, then applies the plan', async () => {
    await withArtifactsDir(async (tempDir) => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({
        getIssue: vi.fn()
          .mockResolvedValueOnce(baseIssue)
          .mockResolvedValueOnce({ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }),
      });
      const model = { generateJson: vi.fn().mockResolvedValueOnce(modelReply('Crash on save', [addBugLabel('policy')], 20)) } as any;

      const result = await processIssue(
        { cfg: makeConfig({ dryRun: false }), db, gh, model, stats },
        processOptions()
      );

      expect(result).toEqual({
        issueNumber: 42,
        type: 'issue',
        title: 'Sample',
        outcome: 'triaged',
        plan: { kinds: ['add_labels'], labels: ['+bug'] },
      });
      expect(gh.listTimelineEvents).toHaveBeenCalledWith(42, TIMELINE_EVENTS, false);
      expect(model.generateJson).toHaveBeenCalledOnce();
      const [request] = model.generateJson.mock.calls[0];
      expect(request).toMatchObject({ model: 'test-model', systemPrompt: 'system prompt' });
      expect(request.userPrompt).toMatch(/=== SECTION: ISSUE TIMELINE EVENTS \(JSON\) ===\n\[[\s\S]*"body": "Ping"[\s\S]*\]\n\n$/);
      expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
      expect((stats.toJSON() as any).actions).toEqual({ total: 1, byKind: { add_labels: 1 } });
      // The database keeps when the item was triaged and the update it consumed, and no longer the model's summary.
      expect(db.items['42']).toEqual({ lastTriaged: expect.any(String), lastSeenUpdatedAt: '2024-04-12T00:00:00Z' });

      const artifactsDir = path.join(tempDir, 'artifacts');
      expect(fs.readdirSync(artifactsDir).sort()).toEqual(['42-analysis.json', '42-operations.json', '42-prompt-user.md', '42-timeline.json']);
      expect(fs.readFileSync(path.join(artifactsDir, '42-prompt-user.md'), 'utf8')).toBe(request.userPrompt);
      expect(fs.readFileSync(path.join(artifactsDir, '42-operations.json'), 'utf8')).toContain('"kind": "add_labels"');
    });
  });

  it('records an empty plan without touching GitHub when the model plans no operations', async () => {
    await withArtifactsDir(async (tempDir) => {
      const db: TriageDb = { version: 2, items: {} };
      const gh = createGitHub({ getIssue: vi.fn() });
      const model = { generateJson: vi.fn().mockResolvedValue(modelReply('Nothing to do', [], 10)) } as any;

      const result = await processIssue(
        { cfg: makeConfig({ dryRun: false }), db, gh, model, stats: new RunStatistics() },
        processOptions()
      );

      expect(result).toMatchObject({ outcome: 'triaged', plan: { kinds: [], labels: [] } });
      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(db.items['42']).toMatchObject({ lastSeenUpdatedAt: '2024-04-10T00:00:00Z' });
      expect(fs.readdirSync(path.join(tempDir, 'artifacts'))).not.toContain('42-operations.json');
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
          .mockResolvedValue(modelReply('Summary', [{
            kind: 'set_state',
            state: 'not_planned',
            authorization: 'policy',
          }], 20)),
      } as any;

      try {
        const result = await processIssue(
          { cfg: makeConfig({ dryRun: false }), db, gh, model, stats },
          processOptions()
        );

        expect(result).toEqual({
          issueNumber: 42,
          type: 'issue',
          title: 'Sample',
          outcome: 'deferred',
          changedDuringAnalysis: true,
          plan: { kinds: ['set_state'], labels: [] },
          detail: "It changed while it was being analyzed, so the plan wasn't applied.",
        });
        expect(gh.updateIssueState).not.toHaveBeenCalled();
        expect(gh.getIssue).toHaveBeenCalledWith(42);
        expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
          '⚠️ #42 changed while it was being analyzed (updated at 2024-04-10T00:00:00Z, now 2024-04-12T00:00:00Z). Deferring its planned operations: state: not_planned.'
        );
        expect(db.items['42']).toBeUndefined();
        expect(buildAutoDiscoverQueue([{ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }], db, false)).toEqual([42]);
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
          },
        },
      };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn().mockRejectedValue(new Error('recheck failed')) });
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Summary', [addBugLabel('policy')], 20)),
      } as any;

      try {
        const result = await processIssue(
          { cfg: makeConfig({ dryRun: false }), db, gh, model, stats },
          processOptions()
        );

        expect(gh.addLabels).not.toHaveBeenCalled();
        expect(db.items['42']).toEqual({
          lastTriaged: '2024-04-05T00:00:00Z',
          lastSeenUpdatedAt: '2024-04-05T00:00:00Z',
        });
        expect(buildAutoDiscoverQueue([baseIssue], db, false)).toEqual([42]);
        expect(result).toMatchObject({
          outcome: 'deferred',
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
      const renamed = { ...baseIssue, title: 'Renamed', updated_at: '2024-04-12T00:00:00Z' };
      const model = { generateJson: vi.fn().mockResolvedValue(modelReply('Summary', [addBugLabel('policy')], 20)) } as any;
      const reanalyze = async (current: typeof renamed) => {
        const gh = createGitHub({ getIssue: vi.fn().mockResolvedValue(current) });
        const result = await processIssue(
          { cfg: makeConfig({ dryRun: false }), db: { version: 2, items: {} }, gh, model, stats: new RunStatistics() },
          processOptions({ issue: renamed, reanalysis: true })
        );
        return { result, gh };
      };

      const applied = await reanalyze(renamed);
      expect(applied.result).toMatchObject({ title: 'Renamed', outcome: 'triaged', reanalyzed: true });
      expect(applied.gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
      expect(core.group).toHaveBeenCalledWith('🤖 #42 Renamed (re-analysis)', expect.any(Function));

      const changedAgain = await reanalyze({ ...renamed, updated_at: '2024-04-13T00:00:00Z' });
      expect(changedAgain.result).toMatchObject({
        outcome: 'deferred',
        reanalyzed: true,
        changedDuringAnalysis: true,
        detail: "It changed again while it was being re-analyzed, so the plan wasn't applied.",
      });
      expect(changedAgain.gh.addLabels).not.toHaveBeenCalled();
    });
  });

  it('uses the analyzed watermark when the post-action refresh fails', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({
        getIssue: vi.fn()
          .mockResolvedValueOnce(baseIssue)
          .mockRejectedValueOnce(new Error('refresh failed')),
      });
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Summary', [addBugLabel('policy')], 20)),
      } as any;

      await processIssue(
        { cfg: makeConfig({ dryRun: false }), db, gh, model, stats },
        processOptions()
      );

      expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
      expect(db.items['42']).toMatchObject({ lastSeenUpdatedAt: '2024-04-10T00:00:00Z' });
    });
  });

  it('does not recheck before executing a dry-run plan', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn() });
      const model = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Summary', [addBugLabel('policy')], 20)),
      } as any;

      const result = await processIssue(
        { cfg: makeConfig({ dryRun: true }), db, gh, model, stats },
        processOptions()
      );

      expect(gh.getIssue).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(result).toEqual({
        issueNumber: 42,
        type: 'issue',
        title: 'Sample',
        outcome: 'triaged',
        plan: { kinds: ['add_labels'], labels: ['+bug'] },
      });
    });
  });

  it('retries a model reply without an operations array, and triages with a non-string summary', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const fetch = chatFetch('{"summary":"s","operations":{}}', '{"summary":7,"operations":[]}');
      const model = new ChatClient(OPENAI, fetch);
      vi.spyOn(model as any, 'sleep').mockResolvedValue(undefined);

      await processIssue({ cfg: makeConfig(), db, gh: createGitHub(), model, stats }, processOptions());

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(db.items['42']).toHaveProperty('lastTriaged');
    });
  });

  it('fails the item without retrying when the reply is cut off', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const fetch = chatFetch({ message: { role: 'assistant', content: '{"summary":"cut' }, finish_reason: 'length' });
      const model = new ChatClient(OPENAI, fetch);

      const error = await processIssue(
        { cfg: makeConfig(), db, gh: createGitHub(), model, stats: new RunStatistics() },
        processOptions()
      ).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(ModelError);
      expect(error).toMatchObject({ kind: 'permanent', message: 'api.openai.com stopped the reply at the output token limit' });
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
          { cfg: makeConfig({ dryRun: false }), db, gh, model: new ChatClient(OPENAI, fetch), stats },
          processOptions()
        );

        const explanation = [
          'Summary: Crash on save',
          'Operations:',
          '- add_labels: Policy 2 labels crashes as bugs',
          '- comment: Policy 4 thanks first-time reporters',
        ].join('\n');
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.bodies[0].messages[0]).toEqual({ role: 'system', content: 'system prompt' });
        expect(fetch.bodies[0].response_format.json_schema.schema.properties.operations.items.anyOf[0].properties.labels.items).toEqual({ type: 'string', enum: ['bug'] });
        expect(log.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringContaining(explanation));
        expect(log.mock.calls.map(call => String(call[0]))).toContainEqual(expect.stringMatching(/Answered in \S+ • 3\.0k input • 20 output • 60 reasoning/));
        expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
        expect(gh.createComment).toHaveBeenCalledWith(42, `Thanks for the report.\n\n<!--\n${explanation}\n-->`);
        expect((stats.toJSON() as any).usage).toMatchObject({ calls: 1, inputTokens: 3050, outputTokens: 20, reasoningTokens: 60 });
        // The raw artifact keeps what the model actually returned.
        const artifact = JSON.parse(fs.readFileSync(path.join(tempDir, 'artifacts', '42-analysis.json'), 'utf8'));
        expect(artifact).toEqual({ summary: 'Crash on save', operations });
      } finally {
        log.mockRestore();
      }
    });
  });

  it('passes a failed model call, GitHub write or timeline read to the runner unchanged', async () => {
    await withArtifactsDir(async () => {
      const unavailable = new ModelError('503 UNAVAILABLE', 'capacity');
      const writeError = githubError(500, 'Internal Server Error');
      const readError = githubError(502, 'Bad Gateway');
      const planner = { generateJson: vi.fn().mockResolvedValue(modelReply('Summary', [addBugLabel('policy')], 20)) } as any;
      const run = (model: any, gh: ReturnType<typeof createGitHub>) => processIssue(
        { cfg: makeConfig({ dryRun: false }), db: { version: 2, items: {} }, gh, model, stats: new RunStatistics() },
        processOptions()
      ).catch((err: unknown) => err);

      expect(await run({ generateJson: vi.fn().mockRejectedValue(unavailable) }, createGitHub())).toBe(unavailable);
      expect(await run(planner, createGitHub({ getIssue: vi.fn().mockResolvedValue(baseIssue), addLabels: vi.fn().mockRejectedValue(writeError) }))).toBe(writeError);
      expect(await run(planner, createGitHub({ listTimelineEvents: vi.fn().mockRejectedValue(readError) }))).toBe(readError);
    });
  });
});
