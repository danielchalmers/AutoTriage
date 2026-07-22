import chalk from 'chalk';

export interface ModelRunStats {
  startTime: number;
  endTime: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  thoughtsTokens?: number;
  totalTokens?: number;
  cacheName?: string;
  issueNumber?: number;
}

export interface CacheCreateStats {
  mode: 'fast' | 'pro';
  model: string;
  name: string;
  tokenCount: number;
}

export interface ActionDetail {
  issueNumber: number;
  type: 'add_labels' | 'remove_labels' | 'comment' | 'set_title' | 'set_state';
  details: string;
}

export type ItemOutcome = 'triaged' | 'skipped' | 'failed';
export type SkipReason = 'noop-fast' | 'other';

// Compact, comparable form of what a pass planned: sorted unique operation
// kinds plus signed label changes (`+bug`, `-stale`).
export interface PlanSummary {
  kinds: string[];
  labels: string[];
}

// How the fast pass's plan relates to the pro pass's plan for one item.
export type PlanAgreement = 'fast-noop' | 'identical' | 'pro-vetoed' | 'differed';

export interface ItemRecord {
  issueNumber: number;
  type?: string;
  outcome: ItemOutcome;
  skipReason?: SkipReason;
  escalatedToPro: boolean;
  fastPlan?: PlanSummary | undefined;
  proPlan?: PlanSummary | undefined;
  agreement?: PlanAgreement | undefined;
  failedPass?: 'fast' | 'pro' | undefined;
}

export interface RunConfigSnapshot {
  dryRun: boolean;
  extended: boolean;
  skipFastPass: boolean;
  maxFastRuns: number;
  maxProRuns: number;
  thinkingLevel: string;
}

export interface PromptHashes {
  fast: string | null;
  pro: string;
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
  private cacheCreates: CacheCreateStats[] = [];
  private actionsPerformed: ActionDetail[] = [];
  private triaged = 0;
  private skipped = 0;
  private failed = 0;
  private githubApiCalls = 0;
  private githubApiRetries = 0;
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

  trackCacheCreate(stats: CacheCreateStats): void {
    this.cacheCreates.push(stats);
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

  incrementTriaged(): void {
    this.triaged++;
  }

  incrementSkipped(): void {
    this.skipped++;
  }

  incrementFailed(): void {
    this.failed++;
  }

  getFailed(): number {
    return this.failed;
  }

  incrementGithubApiCalls(count: number = 1): void {
    this.githubApiCalls += count;
  }

  incrementGithubApiRetries(count: number = 1): void {
    this.githubApiRetries += count;
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

  private calculateStats(runs: ModelRunStats[]): {
    total: number;
    avg: number;
    p95: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    thoughtsTokens: number;
    cacheHitRuns: number;
    cacheReferencedRuns: number;
  } {
    if (runs.length === 0) {
      return {
        total: 0,
        avg: 0,
        p95: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        thoughtsTokens: 0,
        cacheHitRuns: 0,
        cacheReferencedRuns: 0,
      };
    }

    const durations = runs.map(r => r.endTime - r.startTime);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const avg = total / runs.length;
    const sorted = [...durations].sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    const p95 = sorted[p95Index] ?? 0;
    const inputTokens = runs.reduce((sum, r) => sum + r.inputTokens, 0);
    const cachedInputTokens = runs.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0);
    const outputTokens = runs.reduce((sum, r) => sum + r.outputTokens, 0);
    const thoughtsTokens = runs.reduce((sum, r) => sum + (r.thoughtsTokens ?? 0), 0);
    const cacheHitRuns = runs.filter(r => (r.cachedInputTokens ?? 0) > 0).length;
    const cacheReferencedRuns = runs.filter(r => r.cacheName).length;

    return {
      total,
      avg,
      p95,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      thoughtsTokens,
      cacheHitRuns,
      cacheReferencedRuns,
    };
  }

  private getCacheCreateStats(mode: 'fast' | 'pro'): { tokenCount: number; count: number } {
    const creates = this.cacheCreates.filter(cache => cache.mode === mode);
    return {
      tokenCount: creates.reduce((sum, cache) => sum + cache.tokenCount, 0),
      count: creates.length,
    };
  }

  private printModelSummary(label: string, mode: 'fast' | 'pro', model: string, runs: ModelRunStats[]): void {
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
      (stats.thoughtsTokens > 0 ? ` • ${this.formatTokens(stats.thoughtsTokens)} thinking` : '')
    );

    const cacheCreate = this.getCacheCreateStats(mode);
    if (cacheCreate.count > 0 || stats.cachedInputTokens > 0) {
      const cacheParts: string[] = [];
      if (cacheCreate.count > 0) {
        cacheParts.push(`${this.formatTokens(cacheCreate.tokenCount)} created`);
      }
      if (stats.cachedInputTokens > 0) {
        const reused = `${this.formatTokens(stats.cachedInputTokens)}`;
        const reusedPercent = stats.inputTokens > 0
          ? ` (${this.formatPercent(stats.cachedInputTokens / stats.inputTokens)})`
          : '';
        cacheParts.push(`${reused}${reusedPercent} reused`);
      }
      console.log(`    Cache: ${cacheParts.join(' • ')}`);
    }
  }

  printSummary(): void {
    console.log('\n' + chalk.bold('📊 Run Statistics:'));

    if (this.githubApiCalls > 0 || this.githubApiRetries > 0) {
      console.log(`  GitHub API: ${this.githubApiCalls} calls • ${this.githubApiRetries} retries`);
    }

    this.printModelSummary('Fast', 'fast', this.modelFast, this.fastRuns);
    this.printModelSummary('Pro', 'pro', this.modelPro, this.proRuns);

    const actionParts: string[] = [];
    if (this.triaged > 0) actionParts.push(`✅ ${this.triaged} triaged`);
    if (this.skipped > 0) actionParts.push(`ℹ️ ${this.skipped} skipped`);
    if (this.failed > 0) actionParts.push(`❌ ${this.failed} failed`);

    if (actionParts.length > 0) {
      console.log(`  Total: ${actionParts.join(' ')}`);
    }

    if (this.actionsPerformed.length > 0) {
      console.log('\n' + chalk.bold('🎬 Actions Performed:'));

      const byIssue = new Map<number, ActionDetail[]>();
      for (const action of this.actionsPerformed) {
        if (!byIssue.has(action.issueNumber)) {
          byIssue.set(action.issueNumber, []);
        }
        byIssue.get(action.issueNumber)!.push(action);
      }

      const sortedIssues = Array.from(byIssue.keys()).sort((a, b) => a - b);

      for (const issueNumber of sortedIssues) {
        const actions = byIssue.get(issueNumber)!;
        const parts = actions.map(a => a.details);
        console.log(`  #${issueNumber}: ${parts.join(', ')}`);
      }
    }
  }

  private summarizeRuns(mode: 'fast' | 'pro', runs: ModelRunStats[]) {
    const stats = this.calculateStats(runs);
    const cacheCreate = this.getCacheCreateStats(mode);
    return {
      runs: runs.length,
      totalMs: Math.round(stats.total),
      avgMs: runs.length > 0 ? Math.round(stats.avg) : 0,
      p95Ms: Math.round(stats.p95),
      inputTokens: stats.inputTokens,
      cachedInputTokens: stats.cachedInputTokens,
      thoughtsTokens: stats.thoughtsTokens,
      outputTokens: stats.outputTokens,
      cacheCreatedTokens: cacheCreate.tokenCount,
    };
  }

  private perItemModel(runs: ModelRunStats[], issueNumber: number) {
    const matching = runs.filter(r => r.issueNumber === issueNumber);
    if (matching.length === 0) return null;
    return {
      ms: matching.reduce((sum, r) => sum + (r.endTime - r.startTime), 0),
      inputTokens: matching.reduce((sum, r) => sum + r.inputTokens, 0),
      cachedInputTokens: matching.reduce((sum, r) => sum + (r.cachedInputTokens ?? 0), 0),
      thoughtsTokens: matching.reduce((sum, r) => sum + (r.thoughtsTokens ?? 0), 0),
      outputTokens: matching.reduce((sum, r) => sum + r.outputTokens, 0),
    };
  }

  /**
   * Serialize this run into a machine-readable summary. Written as the
   * `run-summary.json` artifact so runs can be aggregated across history for
   * research, rather than scraped from the human-facing log lines.
   */
  toJSON(): Record<string, unknown> {
    const skipReasons: Record<string, number> = {};
    const planAgreement: Record<string, number> = {};
    let escalatedToPro = 0;
    for (const item of this.items.values()) {
      if (item.escalatedToPro) escalatedToPro++;
      if (item.agreement) {
        planAgreement[item.agreement] = (planAgreement[item.agreement] ?? 0) + 1;
      }
      if (item.outcome === 'skipped') {
        const reason = item.skipReason ?? 'other';
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
      }
    }

    const actionsByIssue = new Map<number, string[]>();
    const actionsByKind: Record<string, number> = {};
    for (const action of this.actionsPerformed) {
      if (!actionsByIssue.has(action.issueNumber)) actionsByIssue.set(action.issueNumber, []);
      actionsByIssue.get(action.issueNumber)!.push(action.type);
      actionsByKind[action.type] = (actionsByKind[action.type] ?? 0) + 1;
    }

    const issueNumbers = new Set<number>([
      ...this.items.keys(),
      ...this.fastRuns.map(r => r.issueNumber).filter((n): n is number => n !== undefined),
      ...this.proRuns.map(r => r.issueNumber).filter((n): n is number => n !== undefined),
      ...actionsByIssue.keys(),
    ]);

    const items = Array.from(issueNumbers)
      .sort((a, b) => a - b)
      .map(number => {
        const record = this.items.get(number);
        return {
          number,
          ...(record?.type ? { type: record.type } : {}),
          ...(record?.outcome ? { outcome: record.outcome } : {}),
          ...(record?.skipReason ? { skipReason: record.skipReason } : {}),
          escalatedToPro: record?.escalatedToPro ?? false,
          // undefined fields are dropped by JSON serialization.
          fastPlan: record?.fastPlan,
          proPlan: record?.proPlan,
          agreement: record?.agreement,
          failedPass: record?.failedPass,
          fast: this.perItemModel(this.fastRuns, number),
          pro: this.perItemModel(this.proRuns, number),
          operations: actionsByIssue.get(number) ?? [],
        };
      });

    return {
      schemaVersion: 2,
      repo: this.owner && this.repo ? `${this.owner}/${this.repo}` : '',
      models: {
        fast: this.modelFast || null,
        pro: this.modelPro || null,
      },
      config: this.runConfig,
      promptHash: this.promptHashes,
      github: {
        calls: this.githubApiCalls,
        retries: this.githubApiRetries,
      },
      funnel: {
        discovered: this.discovered,
        processed: this.triaged + this.skipped + this.failed,
        triaged: this.triaged,
        skipped: this.skipped,
        failed: this.failed,
        escalatedToPro,
        capReached: this.capReached,
        skipReasons,
        planAgreement,
      },
      fast: this.summarizeRuns('fast', this.fastRuns),
      pro: this.summarizeRuns('pro', this.proRuns),
      actions: {
        total: this.actionsPerformed.length,
        byKind: actionsByKind,
      },
      items,
    };
  }
}
