import type { AnalysisResult, ModelOperation } from './analysis';
import type { Issue } from './github';
import chalk from 'chalk';

// A planned operation is a model operation plus the thought log we attach to comments.
// Deriving it keeps ModelOperation the single statement of what an operation is, so adding a kind there makes the switches below fail to compile until they handle it.
export type PlannedOperation =
  | Exclude<ModelOperation, { kind: 'comment' }>
  | (Extract<ModelOperation, { kind: 'comment' }> & { thoughts?: string });

const OPERATION_KINDS: readonly ModelOperation['kind'][] = [
  'add_labels',
  'remove_labels',
  'comment',
  'set_title',
  'set_state',
];

const ISSUE_STATES: readonly Extract<ModelOperation, { kind: 'set_state' }>['state'][] = ['open', 'completed', 'not_planned'];

export interface GitHubWriteClient {
  addLabels(issueNumber: number, labels: string[]): Promise<void>;
  removeLabel(issueNumber: number, name: string): Promise<void>;
  createComment(issueNumber: number, body: string): Promise<void>;
  updateTitle(issueNumber: number, title: string): Promise<void>;
  updateIssueState(
    issueNumber: number,
    state: 'open' | 'closed',
    reason?: 'completed' | 'not_planned'
  ): Promise<void>;
}

type StatefulIssue = Pick<Issue, 'number' | 'title' | 'state'> & {
  state_reason?: string | null;
};

function formatCommentBody(body: string, thoughts?: string): string {
  // A '-->' or '--!>' in the thoughts would end the hidden comment early and publish the rest, so escape its '>'.
  const thoughtLog = (thoughts ?? '').trim().replace(/--(!?)>/g, '--$1&gt;');
  const hiddenBlock = thoughtLog.length ? thoughtLog : 'No thoughts provided';
  return `${body}\n\n<!--\n${hiddenBlock}\n-->`;
}

function commentPreview(body: string): string {
  return body.replace(/\n\n<!--[\s\S]*?-->$/g, '').replace(/^/gm, '> ');
}

export function describeOperation(operation: PlannedOperation): string {
  switch (operation.kind) {
    case 'add_labels':
      return `labels: ${operation.labels.map(label => `+${label}`).join(', ')}`;
    case 'remove_labels':
      return `labels: ${operation.labels.map(label => `-${label}`).join(', ')}`;
    case 'comment':
      return 'comment';
    case 'set_title':
      return 'title change';
    case 'set_state':
      return `state: ${operation.state}`;
  }
}

export async function executeOperations(
  operations: PlannedOperation[],
  context: {
    issue: Pick<Issue, 'number' | 'title'>;
    dryRun: boolean;
    gh: GitHubWriteClient;
    onAction?: (operation: PlannedOperation) => void;
  }
): Promise<void> {
  const { issue, dryRun, gh, onAction } = context;

  for (const operation of operations) {
    switch (operation.kind) {
      case 'add_labels':
        console.log(`${chalk.cyan('🏷️ Labels')}: ${operation.labels.map(label => chalk.green(`+${label}`)).join(', ')}`);
        if (!dryRun) await gh.addLabels(issue.number, operation.labels);
        break;
      case 'remove_labels':
        console.log(`${chalk.cyan('🏷️ Labels')}: ${operation.labels.map(label => chalk.red(`-${label}`)).join(', ')}`);
        if (!dryRun) {
          for (const label of operation.labels) {
            await gh.removeLabel(issue.number, label);
          }
        }
        break;
      case 'comment':
        console.log(chalk.cyan('💬 Comment:'));
        console.log(chalk.green(commentPreview(operation.body)));
        if (!dryRun) await gh.createComment(issue.number, formatCommentBody(operation.body, operation.thoughts));
        break;
      case 'set_title':
        console.log(chalk.cyan('✏️ Title:'));
        console.log(chalk.red(`-"${issue.title}"`));
        console.log(chalk.green(`+"${operation.title}"`));
        if (!dryRun) await gh.updateTitle(issue.number, operation.title);
        break;
      case 'set_state':
        if (operation.state === 'open') {
          console.log(`${chalk.cyan('🔄 State')}: Reopening issue`);
          if (!dryRun) await gh.updateIssueState(issue.number, 'open');
        } else {
          console.log(`${chalk.cyan('🔄 State')}: Closing issue as ${operation.state}`);
          if (!dryRun) await gh.updateIssueState(issue.number, 'closed', operation.state);
        }
        break;
    }

    onAction?.(operation);
  }
}

function filterLabels(labels: unknown, repoLabels: string[] | undefined): string[] {
  if (!Array.isArray(labels) || labels.length === 0) return [];
  const unique = [...new Set(labels.filter((label): label is string => typeof label === 'string' && label.trim().length > 0))];
  if (!repoLabels || repoLabels.length === 0) return unique;
  const allowed = new Set(repoLabels);
  // An exact match wins; otherwise take the repository's spelling when exactly one label matches ignoring case.
  const resolved = unique.flatMap(label => {
    if (allowed.has(label)) return [label];
    const matches = [...allowed].filter(name => name.toLowerCase() === label.toLowerCase());
    return matches.length === 1 ? matches : [];
  });
  return [...new Set(resolved)];
}

function hasAuthorization(op: unknown): op is ModelOperation {
  if (!op || typeof op !== 'object') return false;
  const { kind, authorization } = op as { kind?: unknown; authorization?: unknown };
  return OPERATION_KINDS.includes(kind as ModelOperation['kind'])
    && typeof authorization === 'string' && authorization.trim().length > 0;
}

/**
 * The plan's own account of its decisions, for a reply that came without thoughts, as OpenAI's always do.
 * It gives the summary and the policy clause each operation cites, so the log and the hidden comment block still say why.
 */
export function explainPlan(analysis: AnalysisResult): string {
  const operations: unknown[] = Array.isArray(analysis.operations) ? analysis.operations : [];
  const reasons = operations.filter(hasAuthorization).map(op => `- ${op.kind}: ${op.authorization.trim()}`);
  return [
    'The model returned no thoughts, so this is the plan\'s own explanation.',
    `Summary: ${analysis.summary.trim() || '(none)'}`,
    ...(reasons.length > 0 ? ['Operations:', ...reasons] : ['Operations: none']),
  ].join('\n');
}

export function planOperations(
  issue: StatefulIssue,
  analysis: AnalysisResult,
  metadata: { labels?: string[] },
  repoLabels?: string[],
  thoughts?: string
): PlannedOperation[] {
  const ops: PlannedOperation[] = [];
  const modelOps: unknown[] = Array.isArray(analysis.operations) ? analysis.operations : [];
  const currentLabels = new Set(Array.isArray(metadata.labels) ? metadata.labels : []);

  for (const op of modelOps) {
    if (!hasAuthorization(op)) continue;

    switch (op.kind) {
      case 'add_labels': {
        const labels = filterLabels(op.labels, repoLabels).filter(label => !currentLabels.has(label));
        if (labels.length > 0) {
          labels.forEach(label => currentLabels.add(label));
          ops.push({ kind: 'add_labels', labels, authorization: op.authorization });
        }
        break;
      }
      case 'remove_labels': {
        const labels = filterLabels(op.labels, repoLabels).filter(label => currentLabels.has(label));
        if (labels.length > 0) {
          labels.forEach(label => currentLabels.delete(label));
          ops.push({ kind: 'remove_labels', labels, authorization: op.authorization });
        }
        break;
      }
      case 'comment':
        if (typeof op.body === 'string' && op.body.trim().length > 0) {
          ops.push({
            kind: 'comment',
            body: op.body,
            authorization: op.authorization,
            ...(typeof thoughts === 'string' && thoughts.length > 0 ? { thoughts } : {}),
          });
        }
        break;
      case 'set_title':
        if (typeof op.title === 'string' && op.title.trim().length > 0 && op.title !== issue.title) {
          ops.push({ kind: 'set_title', title: op.title, authorization: op.authorization });
        }
        break;
      case 'set_state': {
        // A missing or unknown state would otherwise fall through to closing the issue.
        if (!ISSUE_STATES.includes(op.state)) break;
        const currentState = issue.state;
        const currentReason = issue.state_reason ?? undefined;
        if (op.state === 'open') {
          if (currentState !== 'open') ops.push({ kind: 'set_state', state: 'open', authorization: op.authorization });
        } else if (currentState !== 'closed' || currentReason !== op.state) {
          ops.push({ kind: 'set_state', state: op.state, authorization: op.authorization });
        }
        break;
      }
    }
  }

  return ops;
}
