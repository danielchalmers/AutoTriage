import { color } from './util';
import type { FailureKind } from './llm/chat';
import type { Config } from './config';

export interface ModelRunStats {
  startTime: number;
  endTime: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens?: number;
  issueNumber?: number;
}

// Stated independently of the operation union: this is the run-summary artifact's contract.
export interface ActionDetail {
  issueNumber: number;
  type: 'add_labels' | 'remove_labels' | 'comment' | 'set_title' | 'set_state';
  details: string;
}

// `deferred` means the plan was held back because the item changed during analysis or couldn't be rechecked.
export type ItemOutcome = 'triaged' | 'deferred' | 'failed';
// Why a failed item failed: the model failure kind, or `other` for an error outside the model call.
export type FailureReason = FailureKind | 'other';

// Compact form of what the model planned: sorted unique operation kinds plus signed label changes (`+bug`, `-stale`).
export interface PlanSummary {
  kinds: string[];
  labels: string[];
}

// What happened to one processed item. The run summary's item counts are all derived from these records.
export interface ItemRecord {
  issueNumber: number;
  type?: string | undefined;
  title?: string | undefined;
  outcome: ItemOutcome;
  // True when the item changed during its first analysis and was analyzed again, so the record describes the second analysis.
  reanalyzed?: boolean | undefined;
  // True when the plan was deferred because the item changed during analysis, rather than because it couldn't be rechecked.
  changedDuringAnalysis?: boolean | undefined;
  // What the model planned. A failed item has none.
  plan?: PlanSummary | undefined;
  failureReason?: FailureReason | undefined;
  // One line on why a failed or deferred item didn't finish, for the job summary and the item's warning.
  detail?: string | undefined;
}

function groupByIssue<T>(actions: ActionDetail[], select: (action: ActionDetail) => T): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const action of actions) {
    const bucket = grouped.get(action.issueNumber);
    if (bucket) bucket.push(select(action));
    else grouped.set(action.issueNumber, [select(action)]);
  }
  return grouped;
}

// Token totals, emitted in the key order the run-summary artifact uses.
function sumTokens(runs: ModelRunStats[]) {
  return {
    inputTokens: runs.reduce((sum, r) => sum + r.inputTokens, 0),
    cachedInputTokens: runs.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0),
    reasoningTokens: runs.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0),
    outputTokens: runs.reduce((sum, r) => sum + r.outputTokens, 0),
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m${seconds}s`;
}

function formatPercent(value: number): string {
  const percent = Math.max(0, Math.min(100, value * 100));
  const rounded = Math.round(percent);
  return Math.abs(percent - rounded) < 0.05 ? `${rounded}%` : `${percent.toFixed(1)}%`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

// Some providers, such as Claude's compatibility API, report no reasoning tokens, so the log says so rather than leaving reasoning out.
function describeTokens(tokens: { inputTokens: number; outputTokens: number; reasoningTokens: number }): string {
  const reasoning = tokens.reasoningTokens > 0 ? `${formatTokens(tokens.reasoningTokens)} reasoning` : 'reasoning not reported';
  return `${formatTokens(tokens.inputTokens)} input • ${formatTokens(tokens.outputTokens)} output • ${reasoning}`;
}

// The log line after a model call, with its duration across any retries.
export function describeModelRun(run: ModelRunStats): string {
  return `Answered in ${formatDuration(run.endTime - run.startTime)} • ${describeTokens({ ...run, reasoningTokens: run.reasoningTokens ?? 0 })}`;
}

// Summarize planned operations into the PlanSummary shape.
export function summarizePlan(operations: Array<{ kind: string; labels?: string[] }>): PlanSummary {
  const sign = (kind: string) => (kind === 'add_labels' ? '+' : kind === 'remove_labels' ? '-' : null);
  const labels = operations.flatMap(op => sign(op.kind) ? (op.labels ?? []).map(l => sign(op.kind) + l) : []);
  return {
    kinds: [...new Set(operations.map(op => op.kind))].sort(),
    labels: [...new Set(labels)].sort(),
  };
}

// What a run summary needs to know about the run's settings.
type RunSettings = Pick<Config, 'owner' | 'repo' | 'model' | 'dryRun' | 'maxRuns'>;

export class RunStatistics {
  private modelRuns: ModelRunStats[] = [];
  private actionsPerformed: ActionDetail[] = [];
  private githubApiCalls = 0;
  private discovered = 0;
  private capReached = false;
  private items = new Map<number, ItemRecord>();
  private promptHash: string | null = null;

  constructor(private readonly settings: RunSettings) {}

  trackModelRun(stats: ModelRunStats): void {
    this.modelRuns.push(stats);
  }

  trackAction(action: ActionDetail): void {
    this.actionsPerformed.push(action);
  }

  setDiscovered(count: number): void {
    this.discovered = count;
  }

  setCapReached(): void {
    this.capReached = true;
  }

  setPromptHash(hash: string): void {
    this.promptHash = hash;
  }

  setGithubApiCalls(count: number): void {
    this.githubApiCalls = count;
  }

  recordItem(record: ItemRecord): void {
    this.items.set(record.issueNumber, record);
  }

  // The processed items, in issue order.
  getItems(): ItemRecord[] {
    return [...this.items.values()].sort((a, b) => a.issueNumber - b.issueNumber);
  }

  // The log's description of each operation, by item, in issue order.
  getActionDetails(): Array<[number, string[]]> {
    return [...groupByIssue(this.actionsPerformed, action => action.details)].sort(([a], [b]) => a - b);
  }

  printSummary(): void {
    const { github, usage, funnel } = this.toJSON();
    console.log('\n' + color('bold', '📊 Run Statistics:'));
    if (github.calls > 0) console.log(`  GitHub API: ${github.calls} calls`);

    if (usage.calls > 0) {
      console.log(color('cyan', `  Model (${this.settings.model.model})`));
      console.log(`    Total: ${formatDuration(usage.totalMs)} • Avg: ${formatDuration(usage.avgMs)} • p95: ${formatDuration(usage.p95Ms)}`);
      console.log(`    Tokens: ${describeTokens(usage)}`);
      if (usage.cachedInputTokens > 0) {
        const reusedPercent = usage.inputTokens > 0 ? ` (${formatPercent(usage.cachedInputTokens / usage.inputTokens)})` : '';
        console.log(`    Cache: ${formatTokens(usage.cachedInputTokens)}${reusedPercent} reused`);
      }
    }

    const outcomes: string[] = [];
    if (funnel.triaged > 0) outcomes.push(`✅ ${funnel.triaged} triaged`);
    if (funnel.deferred > 0) outcomes.push(`⏸️ ${funnel.deferred} deferred`);
    if (funnel.failed > 0) outcomes.push(`❌ ${funnel.failed} failed`);
    if (outcomes.length > 0) console.log(`  Total: ${outcomes.join(' ')}`);

    const actions = this.getActionDetails();
    if (actions.length > 0) {
      console.log('\n' + color('bold', '🎬 Actions Performed:'));
      for (const [issueNumber, details] of actions) console.log(`  #${issueNumber}: ${details.join(', ')}`);
    }
  }

  private countOutcomes(): Record<ItemOutcome, number> {
    const counts: Record<ItemOutcome, number> = { triaged: 0, deferred: 0, failed: 0 };
    for (const item of this.items.values()) counts[item.outcome]++;
    return counts;
  }

  private summarizeRuns() {
    const durations = this.modelRuns.map(r => r.endTime - r.startTime).sort((a, b) => a - b);
    const total = durations.reduce((sum, d) => sum + d, 0);
    return {
      calls: durations.length,
      totalMs: total,
      avgMs: durations.length > 0 ? Math.round(total / durations.length) : 0,
      p95Ms: durations[Math.min(Math.floor(durations.length * 0.95), durations.length - 1)] ?? 0,
      ...sumTokens(this.modelRuns),
    };
  }

  private perItemUsage(issueNumber: number) {
    const matching = this.modelRuns.filter(r => r.issueNumber === issueNumber);
    if (matching.length === 0) return null;
    return {
      ms: matching.reduce((sum, r) => sum + (r.endTime - r.startTime), 0),
      ...sumTokens(matching),
    };
  }

  /**
   * Serialize this run into a machine-readable summary.
   * Written as the `run-summary.json` artifact so runs can be aggregated across history for research, rather than scraped from the human-facing log lines.
   * The job summary reads its counts from here too.
   */
  toJSON() {
    const records = this.getItems();
    const actionsByIssue = groupByIssue(this.actionsPerformed, action => action.type);
    const actionsByKind: Record<string, number> = {};
    for (const { type } of this.actionsPerformed) actionsByKind[type] = (actionsByKind[type] ?? 0) + 1;

    // Fields are listed explicitly to keep the artifact's key order stable, and undefined fields are dropped by JSON serialization.
    const items = records.map(record => ({
      number: record.issueNumber,
      type: record.type,
      outcome: record.outcome,
      reanalyzed: record.reanalyzed,
      plan: record.plan,
      failureReason: record.failureReason,
      usage: this.perItemUsage(record.issueNumber),
      operations: actionsByIssue.get(record.issueNumber) ?? [],
    }));

    return {
      schemaVersion: 5,
      repo: `${this.settings.owner}/${this.settings.repo}`,
      model: this.settings.model.model,
      config: { dryRun: this.settings.dryRun, maxRuns: this.settings.maxRuns },
      promptHash: this.promptHash,
      github: {
        calls: this.githubApiCalls,
      },
      funnel: {
        discovered: this.discovered,
        processed: records.length,
        ...this.countOutcomes(),
        capReached: this.capReached,
      },
      usage: this.summarizeRuns(),
      actions: {
        total: this.actionsPerformed.length,
        byKind: actionsByKind,
      },
      items,
    };
  }
}
