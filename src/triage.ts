import type { Config } from './config';
import type { AnalysisResult, ModelOperation } from './analysis';
import type { GitHubClient } from './github';
import chalk from 'chalk';

export interface TriageOperation {
  kind: 'add_labels' | 'remove_labels' | 'comment' | 'set_title' | 'set_state';
  toJSON(): any;
  perform(client: GitHubClient, cfg: Config, issue: any): Promise<void>;
  getActionDetails(): string;
}

class AddLabelsOp implements TriageOperation {
  kind: 'add_labels' = 'add_labels';
  constructor(public labels: string[], public authorization: string) { }
  toJSON() {
    return { kind: this.kind, labels: this.labels, authorization: this.authorization };
  }
  getActionDetails(): string {
    return `labels: ${this.labels.map(l => `+${l}`).join(', ')}`;
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    if (this.labels.length) {
      console.log(`${chalk.cyan('🏷️ Labels')}: ${this.labels.map(label => chalk.green(`+${label}`)).join(', ')}`);
      if (!cfg.dryRun) await client.addLabels(issue.number, this.labels);
    }
  }
}

class RemoveLabelsOp implements TriageOperation {
  kind: 'remove_labels' = 'remove_labels';
  constructor(public labels: string[], public authorization: string) { }
  toJSON() {
    return { kind: this.kind, labels: this.labels, authorization: this.authorization };
  }
  getActionDetails(): string {
    return `labels: ${this.labels.map(l => `-${l}`).join(', ')}`;
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    if (this.labels.length) {
      console.log(`${chalk.cyan('🏷️ Labels')}: ${this.labels.map(label => chalk.red(`-${label}`)).join(', ')}`);
      if (!cfg.dryRun) {
        for (const name of this.labels) await client.removeLabel(issue.number, name);
      }
    }
  }
}

// Post a model-suggested comment (includes hidden thoughts log for traceability).
class CreateCommentOp implements TriageOperation {
  kind: 'comment' = 'comment';
  constructor(public body: string, public authorization: string, private thoughts?: string) { }
  toJSON() { return { kind: this.kind, body: this.body, authorization: this.authorization }; }
  getActionDetails(): string {
    return 'comment';
  }
  async perform(client: GitHubClient, cfg: Config, issue: any): Promise<void> {
    const preview = this.body.replace(/\n\n<!--[\s\S]*?-->$/g, '').replace(/^/gm, '> ');
    const thoughtLog = (this.thoughts ?? '').trim();
    const hiddenBlock = thoughtLog.length ? thoughtLog : 'No thoughts provided';
    const body = `${this.body}\n\n<!--\n${hiddenBlock}\n-->`;
    console.log(chalk.cyan('💬 Comment:'));
    console.log(chalk.green(preview));
    if (!cfg.dryRun) await client.createComment(issue.number, body);
  }
}

// Retitle the issue / PR when model proposes a more canonical, specific title.
class UpdateTitleOp implements TriageOperation {
  kind: 'set_title' = 'set_title';
  constructor(public title: string, public authorization: string) { }
  toJSON() { return { kind: this.kind, title: this.title, authorization: this.authorization }; }
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
  kind: 'set_state' = 'set_state';
  constructor(public state: 'open' | 'completed' | 'not_planned', public authorization: string) { }
  toJSON() { return { kind: this.kind, state: this.state, authorization: this.authorization }; }
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

// Ensure proposed labels exist in the repository; silently drop unknown labels.
function filterLabels(labels: unknown, repoLabels: string[] | undefined): string[] {
  if (!Array.isArray(labels) || labels.length === 0) return [];
  const unique = [...new Set(labels.filter((label): label is string => typeof label === 'string' && label.trim().length > 0))];
  if (!repoLabels || repoLabels.length === 0) return unique;
  const allowed = new Set(repoLabels);
  return unique.filter(l => allowed.has(l));
}

function hasAuthorization(op: unknown): op is ModelOperation {
  if (!op || typeof op !== 'object') return false;
  const maybe = op as { kind?: unknown; authorization?: unknown };
  const validKind = maybe.kind === 'add_labels'
    || maybe.kind === 'remove_labels'
    || maybe.kind === 'comment'
    || maybe.kind === 'set_title'
    || maybe.kind === 'set_state';
  return validKind && typeof maybe.authorization === 'string' && maybe.authorization.trim().length > 0;
}

/**
 * Translate model output into a concrete ordered list of operations.
 * Each operation must be explicitly present, authorized, and non-empty to produce executable work.
 */
export function planOperations(
  issue: any,
  analysis: AnalysisResult,
  metadata: any,
  repoLabels?: string[],
  thoughts?: string
): TriageOperation[] {
  const ops: TriageOperation[] = [];
  const modelOps: unknown[] = Array.isArray(analysis.operations) ? analysis.operations : [];
  const currentLabels = new Set(Array.isArray(metadata.labels) ? (metadata.labels as string[]) : []);

  for (const op of modelOps) {
    if (!hasAuthorization(op)) continue;

    switch (op.kind) {
      case 'add_labels': {
        const labels = filterLabels(op.labels, repoLabels).filter(label => !currentLabels.has(label));
        if (labels.length) {
          labels.forEach(label => currentLabels.add(label));
          ops.push(new AddLabelsOp(labels, op.authorization));
        }
        break;
      }
      case 'remove_labels': {
        const labels = filterLabels(op.labels, repoLabels).filter(label => currentLabels.has(label));
        if (labels.length) {
          labels.forEach(label => currentLabels.delete(label));
          ops.push(new RemoveLabelsOp(labels, op.authorization));
        }
        break;
      }
      case 'comment':
        if (typeof op.body === 'string' && op.body.trim().length > 0) {
          ops.push(new CreateCommentOp(op.body, op.authorization, thoughts));
        }
        break;
      case 'set_title':
        if (typeof op.title === 'string' && op.title.trim() && op.title !== issue.title) {
          ops.push(new UpdateTitleOp(op.title, op.authorization));
        }
        break;
      case 'set_state': {
        const desired = op.state;
        const currentState: 'open' | 'closed' = issue.state;
        const currentReason: string | undefined = issue.state_reason;
        if (desired === 'open') {
          if (currentState !== 'open') ops.push(new UpdateStateOp('open', op.authorization));
        } else if (currentState !== 'closed' || currentReason !== desired) {
          ops.push(new UpdateStateOp(desired, op.authorization));
        }
        break;
      }
    }
  }

  return ops;
}
