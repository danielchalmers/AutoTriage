import type { Config } from './storage';
import type { OperationPlan, OperationPlanResult, TriageState } from './analysis';
import type { GitHubClient } from './github';
import chalk from 'chalk';

export interface TriageOperation {
  kind: 'labels' | 'comment' | 'title' | 'state';
  toJSON(): any;
  perform(client: GitHubClient, cfg: Config, issue: any): Promise<void>;
  getActionDetails(): string;
}

// Apply the delta between current and proposed label sets.
class UpdateLabelsOp implements TriageOperation {
  kind: 'labels' = 'labels';
  constructor(public toAdd: string[], public toRemove: string[], public merged: string[]) { }
  toJSON() {
    return { kind: this.kind, toAdd: this.toAdd, toRemove: this.toRemove, merged: this.merged };
  }
  getActionDetails(): string {
    const parts: string[] = [];
    if (this.toAdd.length) parts.push(...this.toAdd.map(l => `+${l}`));
    if (this.toRemove.length) parts.push(...this.toRemove.map(l => `-${l}`));
    return `labels: ${parts.join(', ')}`;
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    if (this.toAdd.length || this.toRemove.length) {
      const unchanged = this.merged.filter(l => !this.toAdd.includes(l));
      const tintedUnchanged = unchanged.map(label => chalk.dim(label));
      const tintedAdded = this.toAdd.map(label => chalk.green(`+${label}`));
      const tintedRemoved = this.toRemove.map(label => chalk.red(`-${label}`));
      const parts = [...tintedUnchanged, ...tintedAdded, ...tintedRemoved];
      const labelLine = parts.length ? parts.join(', ') : chalk.yellow('none');
      console.log(`${chalk.cyan('🏷️ Labels')}: ${labelLine}`);
      if (!cfg.dryRun) {
        if (this.toAdd.length) await client.addLabels(issue.number, this.toAdd);
        for (const name of this.toRemove) await client.removeLabel(issue.number, name);
      }
    }
  }
}

// Post a model-suggested comment (includes hidden thoughts log for traceability).
class CreateCommentOp implements TriageOperation {
  kind: 'comment' = 'comment';
  constructor(public body: string) { }
  toJSON() { return { kind: this.kind, body: this.body }; }
  getActionDetails(): string {
    return 'comment';
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    const preview = this.body.replace(/\n\n<!--[\s\S]*?-->$/g, '').replace(/^/gm, '> ');
    console.log(chalk.cyan('💬 Comment:'));
    console.log(chalk.green(preview));
    if (!cfg.dryRun) await client.createComment(issue.number, this.body);
  }
}

// Retitle the issue / PR when model proposes a more canonical, specific title.
class UpdateTitleOp implements TriageOperation {
  kind: 'title' = 'title';
  constructor(public title: string) { }
  toJSON() { return { kind: this.kind, title: this.title }; }
  getActionDetails(): string {
    return 'title change';
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    console.log(chalk.cyan('✏️ Title:'));
    console.log(chalk.red(`-"${issue.title}"`));
    console.log(chalk.green(`+"${this.title}"`));
    if (!cfg.dryRun) await client.updateTitle(issue.number, this.title);
  }
}

// Update the issue state (open, completed, not_planned) where completed/not_planned map to closed + reason.
class UpdateStateOp implements TriageOperation {
  kind: 'state' = 'state';
  constructor(public state: TriageState) { }
  toJSON() { return { kind: this.kind, state: this.state }; }
  getActionDetails(): string {
    return `state: ${this.state}`;
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    if (this.state === 'open') {
      console.log(`${chalk.cyan('🔄 State')}: Reopening issue`);
      if (!cfg.dryRun) await client.updateIssueState(issue.number, 'open');
    } else {
      console.log(`${chalk.cyan('🔄 State')}: Closing issue as ${this.state}`);
      if (!cfg.dryRun) await client.updateIssueState(issue.number, 'closed', this.state);
    }
  }
}

function diffLabels(current: string[] = [], proposed: string[] = []) {
  const cur = new Set(current);
  const prop = new Set(proposed);

  const toAdd: string[] = [];
  const toRemove: string[] = [];

  for (const l of prop) if (!cur.has(l)) toAdd.push(l);
  for (const l of cur) if (!prop.has(l)) toRemove.push(l);

  const merged = [...new Set([...proposed])];
  return { toAdd, toRemove, merged };
}

function filterLabels(labels: string[] | undefined, repoLabels: string[] | undefined): string[] | undefined {
  if (!labels || labels.length === 0) return labels;
  if (!repoLabels || repoLabels.length === 0) return labels;
  const allowed = new Set(repoLabels);
  return labels.filter(l => allowed.has(l));
}

function getAuthorization(operation: Record<string, unknown>): string | undefined {
  if (typeof operation.authorization !== 'string') return undefined;
  const authorization = operation.authorization.trim();
  return authorization.length > 0 && authorization.length <= 500 ? authorization : undefined;
}

function isKnownState(value: unknown): value is TriageState {
  return value === 'open' || value === 'completed' || value === 'not_planned';
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeOperation(operation: unknown): OperationPlan | undefined {
  if (!operation || typeof operation !== 'object') return undefined;
  const candidate = operation as Record<string, unknown>;
  const authorization = getAuthorization(candidate);
  if (!authorization) return undefined;

  switch (candidate.kind) {
    case 'add_labels':
    case 'remove_labels': {
      const labels = asStringArray(candidate.labels);
      if (!labels) return undefined;
      return { kind: candidate.kind, labels, authorization };
    }
    case 'comment':
      if (typeof candidate.body !== 'string') return undefined;
      return { kind: 'comment', body: candidate.body, authorization };
    case 'set_state':
      if (!isKnownState(candidate.state)) return undefined;
      return { kind: 'set_state', state: candidate.state, authorization };
    case 'set_title':
      if (typeof candidate.title !== 'string') return undefined;
      return { kind: 'set_title', title: candidate.title, authorization };
    default:
      return undefined;
  }
}

/**
 * Translate model output into a concrete ordered list of operations.
 * Each explicit operation must be present, valid, and internally authorized to produce an op.
 */
export function planOperations(
  issue: any,
  analysis: OperationPlanResult,
  metadata: any,
  repoLabels?: string[],
  thoughts?: string
): TriageOperation[] {
  const ops: TriageOperation[] = [];
  let currentLabels = Array.isArray(metadata.labels) ? [...metadata.labels as string[]] : [];

  for (const rawOperation of analysis.operations || []) {
    const operation = normalizeOperation(rawOperation);
    if (!operation) continue;

    if (operation.kind === 'set_title') {
      const nextTitle = operation.title.trim();
      if (nextTitle && nextTitle !== issue.title) {
        ops.push(new UpdateTitleOp(nextTitle));
      }
      continue;
    }

    if (operation.kind === 'add_labels' || operation.kind === 'remove_labels') {
      const filtered = [...new Set(filterLabels(operation.labels, repoLabels) || [])];
      if (filtered.length === 0) continue;

      const removalSet = new Set(filtered);
      const proposed = operation.kind === 'add_labels'
        ? [...currentLabels, ...filtered]
        : currentLabels.filter((label) => !removalSet.has(label));
      const merged = [...new Set(proposed)];
      const { toAdd, toRemove } = diffLabels(currentLabels, merged);
      if (toAdd.length || toRemove.length) {
        ops.push(new UpdateLabelsOp(toAdd, toRemove, merged));
        currentLabels = merged;
      }
      continue;
    }

    if (operation.kind === 'comment') {
      if (operation.body.trim().length === 0) continue;
      const thoughtLog = (thoughts ?? '').trim();
      const hiddenBlock = thoughtLog.length ? thoughtLog : 'No thoughts provided';
      const body = `${operation.body}\n\n<!--\n${hiddenBlock}\n-->`;
      ops.push(new CreateCommentOp(body));
      continue;
    }

    const desired = operation.state;
    const currentState: 'open' | 'closed' = issue.state;
    const currentReason: string | undefined = issue.state_reason;
    if (desired === 'open') {
      if (currentState !== 'open') ops.push(new UpdateStateOp('open'));
    } else if (currentState !== 'closed' || currentReason !== desired) {
      ops.push(new UpdateStateOp(desired));
    }
  }

  return ops;
}
