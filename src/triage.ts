import * as core from '@actions/core';
import { AnalysisResult, Config } from './types';
import { addLabels, createComment, removeLabel, updateTitle, closeIssue } from './github';

export interface TriageOperation {
  kind: 'labels' | 'comment' | 'title' | 'close';
  toJSON(): any;
  perform(octokit: any, cfg: Config, issue: any): Promise<void>;
}

export class UpdateLabelsOp implements TriageOperation {
  kind: 'labels' = 'labels';
  constructor(public toAdd: string[], public toRemove: string[], public merged: string[]) {}
  toJSON() {
    return { kind: this.kind, toAdd: this.toAdd, toRemove: this.toRemove, merged: this.merged };
  }
  async perform(octokit: any, cfg: Config, issue: any): Promise<void> {
    if (this.toAdd.length || this.toRemove.length) {
      core.info(`Labels => ${this.merged.join(', ')}`);
      if (cfg.enabled) {
        if (this.toAdd.length) await addLabels(octokit, cfg.owner, cfg.repo, issue.number, this.toAdd);
        for (const name of this.toRemove) await removeLabel(octokit, cfg.owner, cfg.repo, issue.number, name);
      }
    }
  }
}

export class CreateCommentOp implements TriageOperation {
  kind: 'comment' = 'comment';
  constructor(public body: string) {}
  toJSON() { return { kind: this.kind, body: this.body }; }
  async perform(octokit: any, cfg: Config, issue: any): Promise<void> {
    core.info(`Comment: ${this.body.substring(0, 120)}...`);
    if (cfg.enabled) await createComment(octokit, cfg.owner, cfg.repo, issue.number, this.body);
  }
}

export class UpdateTitleOp implements TriageOperation {
  kind: 'title' = 'title';
  constructor(public newTitle: string) {}
  toJSON() { return { kind: this.kind, newTitle: this.newTitle }; }
  async perform(octokit: any, cfg: Config, issue: any): Promise<void> {
    core.info(`Title: "${issue.title}" -> "${this.newTitle}"`);
    if (cfg.enabled) await updateTitle(octokit, cfg.owner, cfg.repo, issue.number, this.newTitle);
  }
}

export class CloseIssueOp implements TriageOperation {
  kind: 'close' = 'close';
  toJSON() { return { kind: this.kind }; }
  async perform(octokit: any, cfg: Config, issue: any): Promise<void> {
    core.info('Closing issue');
    if (cfg.enabled) await closeIssue(octokit, cfg.owner, cfg.repo, issue.number, 'not_planned');
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

export function planOperations(
  cfg: Config,
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
    const body = `<!-- ${analysis.reasoning || 'No reasoning provided'} -->\n\n${analysis.comment}`;
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
