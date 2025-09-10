import * as core from '@actions/core';
import type { Config } from "./storage";
import type { AnalysisResult } from "./analysis";
import type { GitHubClient } from './github';

export interface TriageOperation {
  kind: 'labels' | 'comment' | 'title' | 'close';
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
      const labelLine = this.merged.length ? this.merged.join(', ') : 'none';
      core.info(`  🏷️ Labels: ${labelLine}`);
      if (cfg.enabled) {
        if (this.toAdd.length) await client.addLabels(issue.number, this.toAdd);
        for (const name of this.toRemove) await client.removeLabel(issue.number, name);
      }
    }
  }
}

// Post a model-suggested comment (includes hidden reasoning log for traceability).
class CreateCommentOp implements TriageOperation {
  kind: 'comment' = 'comment';
  constructor(public body: string) { }
  toJSON() { return { kind: this.kind, body: this.body }; }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    const preview = this.body.replace(/\s+/g, ' ').slice(0, 120);
    core.info(`  💬 Posting comment for #${issue.number}: ${preview}${this.body.length > 120 ? '…' : ''}`);
    if (cfg.enabled) await client.createComment(issue.number, this.body);
  }
}

// Retitle the issue / PR when model proposes a more canonical, specific title.
class UpdateTitleOp implements TriageOperation {
  kind: 'title' = 'title';
  constructor(public newTitle: string) { }
  toJSON() { return { kind: this.kind, newTitle: this.newTitle }; }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    core.info('  ✏️ Updating title from "' + issue.title + '" to "' + this.newTitle + '"');
    if (cfg.enabled) await client.updateTitle(issue.number, this.newTitle);
  }
}

// Close the issue if the model explicitly flags it (conservative default reason: not_planned).
class CloseIssueOp implements TriageOperation {
  kind: 'close' = 'close';
  toJSON() { return { kind: this.kind }; }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    core.info('  🔒 Closing issue');
    if (cfg.enabled) await client.closeIssue(issue.number, 'not_planned');
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
  repoLabels?: string[]
): TriageOperation[] {
  const ops: TriageOperation[] = [];

  // Labels
  if (Array.isArray(analysis.labels)) {
    const filtered = filterLabels(analysis.labels, repoLabels) || [];
    const current = Array.isArray(metadata.labels) ? (metadata.labels as string[]) : [];
    const { toAdd, toRemove, merged } = diffLabels(current, filtered);
    if (toAdd.length || toRemove.length) ops.push(new UpdateLabelsOp(toAdd, toRemove, merged));
  }

  // Comment
  if (typeof analysis.comment === 'string' && analysis.comment.trim().length > 0) {
    const body = `${analysis.comment}\n\n<!-- ${analysis.reasoning || 'No reasoning provided'} -->`;
    ops.push(new CreateCommentOp(body));
  }

  // Title change
  if (analysis.newTitle && analysis.newTitle.trim() && analysis.newTitle !== issue.title) {
    ops.push(new UpdateTitleOp(analysis.newTitle));
  }

  // Close
  if (analysis.close === true) {
    ops.push(new CloseIssueOp());
  }

  return ops;
}
