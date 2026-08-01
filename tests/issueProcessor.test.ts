import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { buildRunContext, processIssue } from '../src/issueProcessor';
import type { Config } from '../src/config';
import { RunStatistics } from '../src/stats';
import type { TriageDb } from '../src/storage';
import { TimelineEvent } from '../src/github';
import { makeConfig, makeIssue, withArtifactsDir } from './fixtures';

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
      const gemini = {
        generateJson: vi.fn().mockResolvedValue(modelReply('Fast summary', 'Fast thoughts', [], 10)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig(), db, gh, gemini, stats },
        processOptions()
      );

      expect(result).toEqual({ triageUsed: false, fastRunUsed: true });
      expect(gemini.generateJson).toHaveBeenCalledTimes(1);
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
        getIssue: vi.fn().mockResolvedValue({ ...baseIssue, updated_at: '2024-04-12T00:00:00Z' }),
      });
      const gemini = {
        generateJson: vi
          .fn()
          .mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10))
          .mockResolvedValueOnce(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      const result = await processIssue(
        { cfg: createConfig({ dryRun: false }), db, gh, gemini, stats },
        processOptions()
      );

      expect(result).toEqual({ triageUsed: true, fastRunUsed: true });
      expect(gemini.generateJson).toHaveBeenCalledTimes(2);
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

  it('falls back to the original updated_at when the post-action refresh fails', async () => {
    await withArtifactsDir(async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub({ getIssue: vi.fn().mockRejectedValue(new Error('refresh failed')) });
      const gemini = {
        generateJson: vi
          .fn()
          .mockResolvedValue(modelReply('Pro summary', 'Pro thoughts', [addBugLabel('pro policy')], 20)),
      } as any;

      try {
        const result = await processIssue(
          { cfg: createConfig({ dryRun: false, skipFastPass: true }), db, gh, gemini, stats },
          processOptions({ systemPromptFast: '' })
        );

        expect(result).toEqual({ triageUsed: true, fastRunUsed: false });
        expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
        expect(gh.getIssue).toHaveBeenCalledWith(42);
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(db.items['42']).toMatchObject({
          summary: 'Pro summary',
          lastSeenUpdatedAt: '2024-04-10T00:00:00Z',
        });
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it('marks the pass in flight so a thrown error can be attributed', async () => {
    await withArtifactsDir(async () => {
      const db: TriageDb = { version: 2, items: {} };
      const stats = new RunStatistics();
      const gh = createGitHub();
      const gemini = {
        generateJson: vi
          .fn()
          // Fast pass escalates, then the pro pass dies.
          .mockResolvedValueOnce(modelReply('Fast summary', 'Fast thoughts', [addBugLabel('fast policy')], 10))
          .mockRejectedValueOnce(new Error('503 UNAVAILABLE')),
      } as any;

      await expect(
        processIssue({ cfg: createConfig(), db, gh, gemini, stats }, processOptions())
      ).rejects.toThrow('503');
      expect(stats.getCurrentPass()).toBe('pro');
    });
  });
});
