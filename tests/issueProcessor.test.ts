import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { buildRunContext, processIssue } from '../src/issueProcessor';
import type { Config } from '../src/config';
import { RunStatistics } from '../src/stats';
import type { TriageDb } from '../src/storage';
import { Issue, TimelineEvent } from '../src/github';

const baseIssue: Issue = {
  title: 'Sample',
  state: 'open',
  type: 'issue',
  number: 42,
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
  updated_at: '2024-04-10T00:00:00Z',
  created_at: '2024-04-01T00:00:00Z',
};

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
  return {
    owner: 'owner',
    repo: 'repo',
    token: 'token',
    geminiApiKey: 'key',
    dryRun: true,
    promptPath: '',
    readmePath: '',
    skipFastPass: false,
    modelFast: 'fast-model',
    modelPro: 'pro-model',
    maxFastTimelineEvents: 5,
    maxProTimelineEvents: 10,
    maxFastReadmeChars: 0,
    maxProReadmeChars: 0,
    maxFastIssueBodyChars: 5000,
    maxProIssueBodyChars: 5000,
    maxFastTimelineTextChars: 5000,
    maxProTimelineTextChars: 5000,
    maxProRuns: 20,
    maxFastRuns: 100,
    extended: false,
    strictMode: false,
    ...overrides,
  };
}

describe('processIssue', () => {
  it('skips the pro pass when the fast pass plans no operations', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-process-issue-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const db: TriageDb = {};
    const stats = new RunStatistics();
    const gh = {
      listTimelineEvents: vi.fn().mockResolvedValue({
        raw: timelineEvents,
        filtered: timelineEvents,
      }),
      lastUpdated: vi.fn().mockReturnValue(Date.parse('2024-04-11T00:00:00Z')),
    } as any;
    const gemini = {
      generateJson: vi.fn().mockResolvedValue({
        data: { summary: 'Fast summary', operations: [] },
        thoughts: 'Fast thoughts',
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
      }),
    } as any;

    try {
      const result = await processIssue(
        {
          cfg: createConfig(),
          db,
          gh,
          gemini,
          stats,
        },
        {
          issue: baseIssue,
          repoLabels: [{ name: 'bug' }],
          autoDiscover: false,
          systemPromptFast: 'fast system prompt',
          systemPromptPro: 'pro system prompt',
          cacheInfos: new Map(),
          runTimestamp: '2026-05-19T16:16:13.737Z',
        }
      );

      expect(result).toEqual({ triageUsed: false, fastRunUsed: true });
      expect(gemini.generateJson).toHaveBeenCalledTimes(1);
      expect(db['42']).toMatchObject({ summary: 'Fast summary' });

      const files = fs.readdirSync(path.join(tempDir, 'artifacts')).sort();
      expect(files).toContain('42-fast-analysis.json');
      expect(files).toContain('42-prompt-fast-user.md');
      expect(files).toContain('42-timeline.json');
      expect(files).not.toContain('42-operations.json');
      expect(files).not.toContain('42-prompt-user.md');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('runs the pro pass and executes planned operations after the fast pass', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-process-issue-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const db: TriageDb = {};
    const stats = new RunStatistics();
    const gh = {
      listTimelineEvents: vi.fn().mockResolvedValue({
        raw: timelineEvents,
        filtered: timelineEvents,
      }),
      lastUpdated: vi.fn().mockReturnValue(Date.parse('2024-04-11T00:00:00Z')),
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      createComment: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
      updateIssueState: vi.fn().mockResolvedValue(undefined),
    } as any;
    const gemini = {
      generateJson: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            summary: 'Fast summary',
            operations: [{ kind: 'add_labels', labels: ['bug'], authorization: 'fast policy' }],
          },
          thoughts: 'Fast thoughts',
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
        })
        .mockResolvedValueOnce({
          data: {
            summary: 'Pro summary',
            operations: [{ kind: 'add_labels', labels: ['bug'], authorization: 'pro policy' }],
          },
          thoughts: 'Pro thoughts',
          inputTokens: 20,
          cachedInputTokens: 0,
          outputTokens: 10,
        }),
    } as any;

    try {
      const result = await processIssue(
        {
          cfg: createConfig({ dryRun: false }),
          db,
          gh,
          gemini,
          stats,
        },
        {
          issue: baseIssue,
          repoLabels: [{ name: 'bug' }],
          autoDiscover: false,
          systemPromptFast: 'fast system prompt',
          systemPromptPro: 'pro system prompt',
          cacheInfos: new Map(),
          runTimestamp: '2026-05-19T16:16:13.737Z',
        }
      );

      expect(result).toEqual({ triageUsed: true, fastRunUsed: true });
      expect(gemini.generateJson).toHaveBeenCalledTimes(2);
      expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug']);
      expect(db['42']).toMatchObject({ summary: 'Pro summary' });

      const artifactsDir = path.join(tempDir, 'artifacts');
      const files = fs.readdirSync(artifactsDir).sort();
      expect(files).toContain('42-fast-analysis.json');
      expect(files).toContain('42-prompt-fast-user.md');
      expect(files).toContain('42-pro-analysis.json');
      expect(files).toContain('42-prompt-user.md');
      expect(files).toContain('42-operations.json');
      expect(fs.readFileSync(path.join(artifactsDir, '42-operations.json'), 'utf8')).toContain('"kind": "add_labels"');
    } finally {
      cwdSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
