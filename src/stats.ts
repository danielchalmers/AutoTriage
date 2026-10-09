import chalk from 'chalk';
import type { FailureKind } from './llm/chat';

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

// `skipped` means the fast pass planned nothing.
// `deferred` means the review's plan was held back because the item changed during analysis or couldn't be rechecked.
export type ItemOutcome = 'triaged' | 'skipped' | 'deferred' | 'failed';
// Why a failed item failed: the model failure kind, or `other` for an error outside the model call.
export type FailureReason = FailureKind | 'other';

// Compact, comparable form of what a pass planned: sorted unique operation kinds plus signed label changes (`+bug`, `-stale`).
export interface PlanSummary {
  kinds: string[];
  labels: string[];
}

// How the fast pass's plan relates to the pro pass's plan for one item.
export type PlanAgreement = 'fast-noop' | 'identical' | 'pro-vetoed' | 'differed';

// What happened to one processed item. The run summary's item counts are all derived from these records.
export interface ItemRecord {
  issueNumber: number;
  type?: string | undefined;
  title?: string | undefined;
  outcome: ItemOutcome;
  // True when the review pass ran, with or without a fast pass first.
  escalatedToPro: boolean;
  // True when the item changed during its first analysis and was analyzed again, so the record describes the second analysis.
  reanalyzed?: boolean | undefined;
  // True when the review's plan was deferred because the item changed during analysis, rather than because it couldn't be rechecked.
  changedDuringAnalysis?: boolean | undefined;
  fastPlan?: PlanSummary | undefined;
  proPlan?: PlanSummary | undefined;
  agreement?: PlanAgreement | undefined;
  failedPass?: 'fast' | 'pro' | undefined;
  failureReason?: FailureReason | undefined;
  // One line on why a failed or deferred item didn't finish, for the job summary and the item's warning.
  detail?: string | undefined;
}

export interface RunConfigSnapshot {
  dryRun: boolean;
  extended: boolean;
  skipFastPass: boolean;
  maxFastRuns: number;
  maxProRuns: number;
}

export interface PromptHashes {
  fast: string | null;
  pro: string;
}

function countKey(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
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

// Summarize planned operations into the comparable PlanSummary shape.
export function summarizePlan(operations: Array<{ kind: string; labels?: string[] }>): PlanSummary {
  const sign = (kind: string) => (kind === 'add_labels' ? '+' : kind === 'remove_labels' ? '-' : null);
  const labels = operations.flatMap(op => sign(op.kind) ? (op.labels ?? []).map(l => sign(op.kind) + l) : []);
  return {
    kinds: [...new Set(operations.map(op => op.kind))].sort(),
    labels: [...new Set(labels)].sort(),
  };
}

// Compare an escalated fast plan against the pro plan that reviewed it.
export function comparePlans(fastPlan: PlanSummary, proPlan: PlanSummary): PlanAgreement {
  if (proPlan.kinds.length === 0) return 'pro-vetoed';
  const same = (a: string[], b: string[]) => a.join('\n') === b.join('\n');
  return same(fastPlan.kinds, proPlan.kinds) && same(fastPlan.labels, proPlan.labels)
    ? 'identical'
    : 'differed';
}

export type CapReached = 'fast' | 'pro' | 'none';

export class RunStatistics {
  private fastRuns: ModelRunStats[] = [];
  private proRuns: ModelRunStats[] = [];
  private actionsPerformed: ActionDetail[] = [];
  private githubApiCalls = 0;
  private owner = '';
  private repo = '';
  private modelFast = '';
  private modelPro = '';
  private discovered = 0;
  private capReached: CapReached = 'none';
  private items = new Map<number, ItemRecord>();
  private runConfig: RunConfigSnapshot | null = null;
  private promptHashes: PromptHashes | null = null;

  setRepository(owner: string, repo: string): void {
    this.owner = owner;
    this.repo = repo;
  }

  setModelNames(modelFast: string, modelPro: string): void {
    this.modelFast = modelFast;
    this.modelPro = modelPro;
  }


  trackFastRun(stats: ModelRunStats): void {
    this.fastRuns.push(stats);
  }

  trackProRun(stats: ModelRunStats): void {
    this.proRuns.push(stats);
  }


  trackAction(action: ActionDetail): void {
    this.actionsPerformed.push(action);
  }

  setDiscovered(count: number): void {
    this.discovered = count;
  }

  setCapReached(cap: CapReached): void {
    this.capReached = cap;
  }

  setRunConfig(config: RunConfigSnapshot): void {
    this.runConfig = config;
  }

  setPromptHashes(hashes: PromptHashes): void {
    this.promptHashes = hashes;
  }

  recordItem(record: ItemRecord): void {
    this.items.set(record.issueNumber, record);
  }

  // The processed items, in issue order.
  getItems(): ItemRecord[] {
    return [...this.items.values()].sort((a, b) => a.issueNumber - b.issueNumber);
  }

  // The log's description of each operation, by item.
  getActionDetails(): Map<number, string[]> {
    return groupByIssue(this.actionsPerformed, action => action.details);
  }

  incrementGithubApiCalls(count: number = 1): void {
    this.githubApiCalls += count;
  }

  private countOutcomes(): Record<ItemOutcome, number> {
    const counts: Record<ItemOutcome, number> = { triaged: 0, skipped: 0, deferred: 0, failed: 0 };
    for (const item of this.items.values()) counts[item.outcome]++;
    return counts;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m${seconds}s`;
  }

  private formatTokens(count: number): string {
    if (count < 1000) return `${count}`;
    if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
  }

  private formatPercent(value: number): string {
    const percent = Math.max(0, Math.min(100, value * 100));
    const rounded = Math.round(percent);
    if (Math.abs(percent - rounded) < 0.05) return `${rounded}%`;
    return `${percent.toFixed(1)}%`;
  }

  private calculateStats(runs: ModelRunStats[]) {
    const durations = runs.map(r => r.endTime - r.startTime);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const sorted = [...durations].sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);

    return {
      total,
      avg: runs.length > 0 ? total / runs.length : 0,
      p95: sorted[p95Index] ?? 0,
      ...sumTokens(runs),
    };
  }

  private printModelSummary(label: string, model: string, runs: ModelRunStats[]): void {
    if (runs.length === 0) return;

    const stats = this.calculateStats(runs);
    const modelLabel = model ? ` (${model})` : '';
    console.log(chalk.cyan(`  ${label}${modelLabel}`));
    console.log(
      `    Total: ${this.formatDuration(stats.total)} • ` +
      `Avg: ${this.formatDuration(stats.avg)} • ` +
      `p95: ${this.formatDuration(stats.p95)}`
    );
    console.log(
      `    Tokens: ${this.formatTokens(stats.inputTokens)} input • ` +
      `${this.formatTokens(stats.outputTokens)} output` +
      (stats.reasoningTokens > 0 ? ` • ${this.formatTokens(stats.reasoningTokens)} reasoning` : '')
    );

    if (stats.cachedInputTokens > 0) {
      const reusedPercent = stats.inputTokens > 0 ? ` (${this.formatPercent(stats.cachedInputTokens / stats.inputTokens)})` : '';
      console.log(`    Cache: ${this.formatTokens(stats.cachedInputTokens)}${reusedPercent} reused`);
    }
  }

  printSummary(): void {
    console.log('\n' + chalk.bold('📊 Run Statistics:'));

    if (this.githubApiCalls > 0) {
      console.log(`  GitHub API: ${this.githubApiCalls} calls`);
    }

    this.printModelSummary('Fast', this.modelFast, this.fastRuns);
    this.printModelSummary('Pro', this.modelPro, this.proRuns);

    const { triaged, skipped, deferred, failed } = this.countOutcomes();
    const actionParts: string[] = [];
    if (triaged > 0) actionParts.push(`✅ ${triaged} triaged`);
    if (skipped > 0) actionParts.push(`ℹ️ ${skipped} skipped`);
    if (deferred > 0) actionParts.push(`⏸️ ${deferred} deferred`);
    if (failed > 0) actionParts.push(`❌ ${failed} failed`);

    if (actionParts.length > 0) {
      console.log(`  Total: ${actionParts.join(' ')}`);
    }

    if (this.actionsPerformed.length > 0) {
      console.log('\n' + chalk.bold('🎬 Actions Performed:'));

      for (const [issueNumber, details] of [...this.getActionDetails()].sort(([a], [b]) => a - b)) {
        console.log(`  #${issueNumber}: ${details.join(', ')}`);
      }
    }
  }

  private summarizeRuns(runs: ModelRunStats[]) {
    const stats = this.calculateStats(runs);
    return {
      runs: runs.length,
      totalMs: Math.round(stats.total),
      avgMs: Math.round(stats.avg),
      p95Ms: Math.round(stats.p95),
      ...sumTokens(runs),
    };
  }

  private perItemModel(runs: ModelRunStats[], issueNumber: number) {
    const matching = runs.filter(r => r.issueNumber === issueNumber);
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
    const planAgreement: Record<string, number> = {};
    let escalatedToPro = 0;
    for (const item of records) {
      if (item.escalatedToPro) escalatedToPro++;
      if (item.agreement) countKey(planAgreement, item.agreement);
    }

    const actionsByIssue = groupByIssue(this.actionsPerformed, action => action.type);
    const actionsByKind: Record<string, number> = {};
    for (const action of this.actionsPerformed) {
      countKey(actionsByKind, action.type);
    }

    // Fields are listed explicitly to keep the artifact's key order stable, and undefined fields are dropped by JSON serialization.
    const items = records.map(record => ({
      number: record.issueNumber,
      type: record.type,
      outcome: record.outcome,
      escalatedToPro: record.escalatedToPro,
      reanalyzed: record.reanalyzed,
      fastPlan: record.fastPlan,
      proPlan: record.proPlan,
      agreement: record.agreement,
      failedPass: record.failedPass,
      failureReason: record.failureReason,
      fast: this.perItemModel(this.fastRuns, record.issueNumber),
      pro: this.perItemModel(this.proRuns, record.issueNumber),
      operations: actionsByIssue.get(record.issueNumber) ?? [],
    }));

    return {
      schemaVersion: 5,
      repo: this.owner && this.repo ? `${this.owner}/${this.repo}` : '',
      models: {
        fast: this.modelFast || null,
        pro: this.modelPro || null,
      },
      config: this.runConfig,
      promptHash: this.promptHashes,
      github: {
        calls: this.githubApiCalls,
      },
      funnel: {
        discovered: this.discovered,
        processed: records.length,
        ...this.countOutcomes(),
        escalatedToPro,
        capReached: this.capReached,
        planAgreement,
      },
      fast: this.summarizeRuns(this.fastRuns),
      pro: this.summarizeRuns(this.proRuns),
      actions: {
        total: this.actionsPerformed.length,
        byKind: actionsByKind,
      },
      items,
    };
  }
}
