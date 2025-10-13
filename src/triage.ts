import type { Config } from "./storage";
import type { AnalysisResult } from "./analysis";
import type { GitHubClient } from './github';
import chalk from 'chalk';

export interface TriageOperation {
  kind: 'labels' | 'comment' | 'title' | 'state';
  toJSON(): any;
  perform(client: GitHubClient, cfg: Config, issue: any): Promise<void>;
}

// Apply the delta between current and proposed label sets.
class UpdateLabelsOp implements TriageOperation {
  kind: 'labels' = 'labels';
  constructor(public toAdd: string[], public toRemove: string[], public merged: string[]) { }
  toJSON() {
    return { kind: this.kind, toAdd: this.toAdd, toRemove: this.toRemove, merged: this.merged };
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    if (this.toAdd.length || this.toRemove.length) {
      // Build log line showing: unchanged labels, +added labels, -removed labels.
      // Example: 🏷️ Labels: docs, +bug, -enhancement
      const unchanged = this.merged.filter(l => !this.toAdd.includes(l));
      const tintedUnchanged = unchanged.map(label => chalk.dim(label));
      const tintedAdded = this.toAdd.map(label => chalk.green(`+${label}`));
      const tintedRemoved = this.toRemove.map(label => chalk.red(`-${label}`));
      const parts = [...tintedUnchanged, ...tintedAdded, ...tintedRemoved];
      const labelLine = parts.length ? parts.join(', ') : chalk.yellow('none');
      console.log(`${chalk.cyan('🏷️ Labels')}: ${labelLine}`);
      if (cfg.enabled) {
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
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    const preview = this.body.replace(/\n\n<!--[\s\S]*?-->$/g, '').replace(/^/gm, '> ');
    console.log(`${chalk.cyan('💬 Comment')}: ${chalk.green(preview)}`);
    if (cfg.enabled) await client.createComment(issue.number, this.body);
  }
}

// Retitle the issue / PR when model proposes a more canonical, specific title.
class UpdateTitleOp implements TriageOperation {
  kind: 'title' = 'title';
  constructor(public newTitle: string) { }
  toJSON() { return { kind: this.kind, newTitle: this.newTitle }; }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    console.log(chalk.cyan('✏️ Title:'));
    console.log(chalk.red(`-"${issue.title}"`));
    console.log(chalk.green(`+"${this.newTitle}"`));
    if (cfg.enabled) await client.updateTitle(issue.number, this.newTitle);
  }
}

// Update the issue state (open, completed, not_planned) where completed/not_planned map to closed + reason.
class UpdateStateOp implements TriageOperation {
  kind: 'state' = 'state';
  constructor(public state: 'open' | 'completed' | 'not_planned') { }
  toJSON() { return { kind: this.kind, state: this.state }; }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    if (this.state === 'open') {
      console.log(`${chalk.cyan('🔄 State')}: Reopening issue`);
      if (cfg.enabled) await client.updateIssueState(issue.number, 'open');
    } else {
      console.log(`${chalk.cyan('🔄 State')}: Closing issue as ${this.state}`);
      if (cfg.enabled) await client.updateIssueState(issue.number, 'closed', this.state);
    }
  }
}

// Compute minimal label add/remove set while preserving proposed order for merged preview.
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

// Ensure proposed labels exist in the repository; silently drop unknown labels.
function filterLabels(labels: string[] | undefined, repoLabels: string[] | undefined): string[] | undefined {
  if (!labels || labels.length === 0) return labels;
  if (!repoLabels || repoLabels.length === 0) return labels;
  const allowed = new Set(repoLabels);
  return labels.filter(l => allowed.has(l));
}

/**
 * Translate model output into a concrete ordered list of operations.
 * Each optional field must be explicitly present and valid to produce an op.
 */
export function planOperations(
  issue: any,
  analysis: AnalysisResult,
  metadata: any,
  repoLabels?: string[],
  thoughts?: string
): TriageOperation[] {
  const ops: TriageOperation[] = [];

  // Title change
  if (analysis.newTitle && analysis.newTitle.trim() && analysis.newTitle !== issue.title) {
    ops.push(new UpdateTitleOp(analysis.newTitle));
  }

  // Labels
  if (Array.isArray(analysis.labels)) {
    const filtered = filterLabels(analysis.labels, repoLabels) || [];
    const current = Array.isArray(metadata.labels) ? (metadata.labels as string[]) : [];
    const { toAdd, toRemove, merged } = diffLabels(current, filtered);
    if (toAdd.length || toRemove.length) ops.push(new UpdateLabelsOp(toAdd, toRemove, merged));
  }

  // Comment
  if (typeof analysis.comment === 'string' && analysis.comment.trim().length > 0) {
    const thoughtLog = (thoughts ?? '').trim();
    const hiddenBlock = thoughtLog.length ? thoughtLog : 'No thoughts provided';
    const body = `${analysis.comment}\n\n<!--\n${hiddenBlock}\n-->`;
    ops.push(new CreateCommentOp(body));
  }

  // State change (open|completed|not_planned). Only act if different from current state/reason.
  if (analysis.state === 'open' || analysis.state === 'completed' || analysis.state === 'not_planned') {
    const desired = analysis.state;
    const currentState: 'open' | 'closed' = issue.state;
    const currentReason: string | undefined = issue.state_reason; // may be undefined
    if (desired === 'open') {
      if (currentState !== 'open') ops.push(new UpdateStateOp('open'));
    } else {
      if (currentState !== 'closed' || currentReason !== desired) {
        ops.push(new UpdateStateOp(desired));
      }
    }
  }

  return ops;
}
