/// <reference types="vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeOperation, executeOperations } from '../src/triage';
import type { GitHubWriteClient, PlannedOperation } from '../src/triage';

describe('executeOperations', () => {
  const issue = { number: 42, title: 'Original title' };
  let gh: GitHubWriteClient;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    gh = {
      addLabels: vi.fn().mockResolvedValue(undefined),
      removeLabel: vi.fn().mockResolvedValue(undefined),
      createComment: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
      updateIssueState: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('does not call GitHub in dry-run mode', async () => {
    const operations: PlannedOperation[] = [
      { kind: 'add_labels', labels: ['bug'], authorization: 'auth' },
      { kind: 'remove_labels', labels: ['help wanted'], authorization: 'auth' },
      { kind: 'comment', body: 'Hello', authorization: 'auth', thoughts: 'hidden' },
      { kind: 'set_title', title: 'New title', authorization: 'auth' },
      { kind: 'set_state', state: 'completed', authorization: 'auth' },
    ];
    const onAction = vi.fn();

    await executeOperations(operations, { issue, dryRun: true, gh, onAction });

    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
    expect(gh.createComment).not.toHaveBeenCalled();
    expect(gh.updateTitle).not.toHaveBeenCalled();
    expect(gh.updateIssueState).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(5);
  });

  it('calls label mutation methods with the planned payloads', async () => {
    await executeOperations(
      [
        { kind: 'add_labels', labels: ['bug', 'feature'], authorization: 'auth' },
        { kind: 'remove_labels', labels: ['help wanted', 'needs info'], authorization: 'auth' },
      ],
      { issue, dryRun: false, gh }
    );

    expect(gh.addLabels).toHaveBeenCalledWith(42, ['bug', 'feature']);
    expect(gh.removeLabel).toHaveBeenNthCalledWith(1, 42, 'help wanted');
    expect(gh.removeLabel).toHaveBeenNthCalledWith(2, 42, 'needs info');
  });

  it('preserves the hidden thoughts comment block', async () => {
    await executeOperations(
      [{ kind: 'comment', body: 'Hello there', authorization: 'auth', thoughts: 'Internal note' }],
      { issue, dryRun: false, gh }
    );

    expect(gh.createComment).toHaveBeenCalledWith(42, 'Hello there\n\n<!--\nInternal note\n-->');
  });

  it('falls back to a placeholder when thoughts are missing', async () => {
    await executeOperations(
      [{ kind: 'comment', body: 'Hello there', authorization: 'auth' }],
      { issue, dryRun: false, gh }
    );

    expect(gh.createComment).toHaveBeenCalledWith(42, 'Hello there\n\n<!--\nNo thoughts provided\n-->');
  });

  it('updates the title with the planned value', async () => {
    await executeOperations(
      [{ kind: 'set_title', title: 'Better title', authorization: 'auth' }],
      { issue, dryRun: false, gh }
    );

    expect(gh.updateTitle).toHaveBeenCalledWith(42, 'Better title');
  });

  it('maps completed and not_planned state updates to closed with the right reason', async () => {
    await executeOperations(
      [
        { kind: 'set_state', state: 'completed', authorization: 'auth' },
        { kind: 'set_state', state: 'not_planned', authorization: 'auth' },
      ],
      { issue, dryRun: false, gh }
    );

    expect(gh.updateIssueState).toHaveBeenNthCalledWith(1, 42, 'closed', 'completed');
    expect(gh.updateIssueState).toHaveBeenNthCalledWith(2, 42, 'closed', 'not_planned');
  });

  it('reopens issues when requested', async () => {
    await executeOperations(
      [{ kind: 'set_state', state: 'open', authorization: 'auth' }],
      { issue, dryRun: false, gh }
    );

    expect(gh.updateIssueState).toHaveBeenCalledWith(42, 'open');
  });
});

describe('describeOperation', () => {
  it('matches the existing stats strings', () => {
    expect(describeOperation({ kind: 'add_labels', labels: ['bug', 'feature'], authorization: 'auth' })).toBe(
      'labels: +bug, +feature'
    );
    expect(describeOperation({ kind: 'remove_labels', labels: ['bug'], authorization: 'auth' })).toBe('labels: -bug');
    expect(describeOperation({ kind: 'comment', body: 'Hello', authorization: 'auth' })).toBe('comment');
    expect(describeOperation({ kind: 'set_title', title: 'New title', authorization: 'auth' })).toBe('title change');
    expect(describeOperation({ kind: 'set_state', state: 'completed', authorization: 'auth' })).toBe('state: completed');
  });
});
