import chalk from 'chalk';
import type { PromptBudgetContentStats } from './analysis';

export interface ModelRunStats {
  startTime: number;
  endTime: number;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  cacheName?: string;
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

type ModelMode = 'fast' | 'pro';
type StopReason = 'fast_limit' | 'pro_limit' | 'consecutive_failures';
type ItemOutcome = 'triaged' | 'skipped' | 'failed';
type ActionType = ActionDetail['type'];

type RunStatisticsContext = {
  owner: string;
  repo: string;
  modelFast: string;
  modelPro: string;
};

type ModeStatisticsState = {
  runs: ModelRunStats[];
  cacheCreates: CacheCreateStats[];
  budgetContent: PromptBudgetContentStats;
};

type RunStatisticsState = {
  startedAt: number;
  context: RunStatisticsContext;
  items: {
    discovered: number;
    attempted: number;
    triaged: number;
    skipped: number;
    failed: number;
    stopReasons: Record<StopReason, number>;
  };
  github: {
    calls: number;
    retries: number;
  };
  modes: Record<ModelMode, ModeStatisticsState>;
  actions: {
    details: ActionDetail[];
    counts: Record<ActionType, number>;
  };
};

const ACTION_TYPES: readonly ActionType[] = [
  'add_labels',
  'remove_labels',
  'comment',
  'set_title',
  'set_state',
];

const STOP_REASON_LABELS: Record<StopReason, string> = {
  fast_limit: 'fast limit reached',
  pro_limit: 'pro limit reached',
  consecutive_failures: 'stopped after consecutive failures',
};

function createEmptyBudgetContent(): PromptBudgetContentStats {
  return { originalChars: 0, keptChars: 0 };
}

function createActionCounts(): Record<ActionType, number> {
  return {
    add_labels: 0,
    remove_labels: 0,
    comment: 0,
    set_title: 0,
    set_state: 0,
  };
}

function createStopReasonCounts(): Record<StopReason, number> {
  return {
    fast_limit: 0,
    pro_limit: 0,
    consecutive_failures: 0,
  };
}

function createModeState(): ModeStatisticsState {
  return {
    runs: [],
    cacheCreates: [],
    budgetContent: createEmptyBudgetContent(),
  };
}

function createDefaultContext(): RunStatisticsContext {
  return {
    owner: '',
    repo: '',
    modelFast: '',
    modelPro: '',
  };
}

function createState(): RunStatisticsState {
  return {
    startedAt: Date.now(),
    context: createDefaultContext(),
    items: {
      discovered: 0,
      attempted: 0,
      triaged: 0,
      skipped: 0,
      failed: 0,
      stopReasons: createStopReasonCounts(),
    },
    github: {
      calls: 0,
      retries: 0,
    },
    modes: {
      fast: createModeState(),
      pro: createModeState(),
    },
    actions: {
      details: [],
      counts: createActionCounts(),
    },
  };
}

let currentRunStatistics: RunStatistics | undefined;

export function initializeRunStatistics(context: Partial<RunStatisticsContext> = {}): RunStatistics {
  currentRunStatistics = new RunStatistics(context);
  return currentRunStatistics;
}

export function getRunStatistics(): RunStatistics {
  if (!currentRunStatistics) {
    currentRunStatistics = new RunStatistics();
  }
  return currentRunStatistics;
}

export function resetRunStatistics(): void {
  currentRunStatistics = undefined;
}

export class RunStatistics {
  private state: RunStatisticsState = createState();

  constructor(context: Partial<RunStatisticsContext> = {}) {
    this.configure(context);
  }

  configure(context: Partial<RunStatisticsContext>): this {
    if (context.owner !== undefined) this.state.context.owner = context.owner;
    if (context.repo !== undefined) this.state.context.repo = context.repo;
    if (context.modelFast !== undefined) this.state.context.modelFast = context.modelFast;
    if (context.modelPro !== undefined) this.state.context.modelPro = context.modelPro;
    return this;
  }

  setRepository(owner: string, repo: string): void {
    this.configure({ owner, repo });
  }

  setModelNames(modelFast: string, modelPro: string): void {
    this.configure({ modelFast, modelPro });
  }

  recordDiscoveredTargets(count: number): void {
    this.state.items.discovered = Math.max(0, count);
  }

  recordItemAttempted(): void {
    this.state.items.attempted++;
  }

  recordItemOutcome(outcome: ItemOutcome): void {
    this.state.items[outcome]++;
  }

  recordStopReason(reason: StopReason): void {
    this.state.items.stopReasons[reason]++;
  }

  trackFastRun(stats: ModelRunStats): void {
    this.recordModelRun('fast', stats);
  }

  trackProRun(stats: ModelRunStats): void {
    this.recordModelRun('pro', stats);
  }

  trackCacheCreate(stats: CacheCreateStats): void {
    this.state.modes[stats.mode].cacheCreates.push(stats);
  }

  trackAction(action: ActionDetail): void {
    this.state.actions.details.push(action);
    this.state.actions.counts[action.type]++;
  }

  trackBudgetContent(mode: ModelMode, stats: PromptBudgetContentStats): void {
    const current = this.state.modes[mode].budgetContent;
    this.state.modes[mode].budgetContent = {
      originalChars: current.originalChars + stats.originalChars,
      keptChars: current.keptChars + stats.keptChars,
    };
  }

  incrementTriaged(): void {
    this.recordItemOutcome('triaged');
  }

  incrementSkipped(): void {
    this.recordItemOutcome('skipped');
  }

  incrementFailed(): void {
    this.recordItemOutcome('failed');
  }

  getFailed(): number {
    return this.state.items.failed;
  }

  incrementGithubApiCalls(count: number = 1): void {
    this.state.github.calls += count;
  }

  incrementGithubApiRetries(count: number = 1): void {
    this.state.github.retries += count;
  }

  private recordModelRun(mode: ModelMode, stats: ModelRunStats): void {
    this.state.modes[mode].runs.push(stats);
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m${seconds}s`;
  }

  private formatTokens(count: number): string {
    if (count < 1000) return `${Math.round(count)}`;
    if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
    return `${(count / 1000000).toFixed(1)}M`;
  }

  private formatPercent(value: number): string {
    const percent = Math.max(0, Math.min(100, value * 100));
    const rounded = Math.round(percent);
    if (Math.abs(percent - rounded) < 0.05) return `${rounded}%`;
    return `${percent.toFixed(1)}%`;
  }

  private calculateModeMetrics(mode: ModelMode): {
    runCount: number;
    totalDuration: number;
    averageDuration: number;
    p95Duration: number;
    totalInputTokens: number;
    averageInputTokens: number;
    totalOutputTokens: number;
    averageOutputTokens: number;
    totalCachedInputTokens: number;
    cacheCreateTokenCount: number;
    cacheCreateCount: number;
    cacheHitRuns: number;
    cacheReferencedRuns: number;
    budgetContent: PromptBudgetContentStats;
  } {
    const modeState = this.state.modes[mode];
    const runs = modeState.runs;
    const cacheCreates = modeState.cacheCreates;

    if (runs.length === 0) {
      return {
        runCount: 0,
        totalDuration: 0,
        averageDuration: 0,
        p95Duration: 0,
        totalInputTokens: 0,
        averageInputTokens: 0,
        totalOutputTokens: 0,
        averageOutputTokens: 0,
        totalCachedInputTokens: 0,
        cacheCreateTokenCount: cacheCreates.reduce((sum, cache) => sum + cache.tokenCount, 0),
        cacheCreateCount: cacheCreates.length,
        cacheHitRuns: 0,
        cacheReferencedRuns: 0,
        budgetContent: modeState.budgetContent,
      };
    }

    const durations = runs.map((run) => run.endTime - run.startTime);
    const sortedDurations = [...durations].sort((a, b) => a - b);
    const totalDuration = durations.reduce((sum, duration) => sum + duration, 0);
    const totalInputTokens = runs.reduce((sum, run) => sum + run.inputTokens, 0);
    const totalOutputTokens = runs.reduce((sum, run) => sum + run.outputTokens, 0);
    const totalCachedInputTokens = runs.reduce((sum, run) => sum + (run.cachedInputTokens ?? 0), 0);
    const cacheReferencedRuns = runs.filter((run) => !!run.cacheName).length;
    const cacheHitRuns = runs.filter((run) => (run.cachedInputTokens ?? 0) > 0).length;

    return {
      runCount: runs.length,
      totalDuration,
      averageDuration: totalDuration / runs.length,
      p95Duration: sortedDurations[Math.min(Math.floor(sortedDurations.length * 0.95), sortedDurations.length - 1)] ?? 0,
      totalInputTokens,
      averageInputTokens: totalInputTokens / runs.length,
      totalOutputTokens,
      averageOutputTokens: totalOutputTokens / runs.length,
      totalCachedInputTokens,
      cacheCreateTokenCount: cacheCreates.reduce((sum, cache) => sum + cache.tokenCount, 0),
      cacheCreateCount: cacheCreates.length,
      cacheHitRuns,
      cacheReferencedRuns,
      budgetContent: modeState.budgetContent,
    };
  }

  private printModelSummary(label: string, mode: ModelMode): void {
    const metrics = this.calculateModeMetrics(mode);
    if (metrics.runCount === 0) return;

    const modelName = mode === 'fast' ? this.state.context.modelFast : this.state.context.modelPro;
    const modelLabel = modelName ? ` (${modelName})` : '';

    console.log(chalk.cyan(`  ${label}${modelLabel}`));
    console.log(
      `    Runs: ${metrics.runCount} • ` +
      `Avg input: ${this.formatTokens(metrics.averageInputTokens)} • ` +
      `Avg output: ${this.formatTokens(metrics.averageOutputTokens)}`
    );
    console.log(
      `    Total: ${this.formatDuration(metrics.totalDuration)} • ` +
      `Avg: ${this.formatDuration(metrics.averageDuration)} • ` +
      `p95: ${this.formatDuration(metrics.p95Duration)}`
    );
    console.log(
      `    Tokens: ${this.formatTokens(metrics.totalInputTokens)} input • ` +
      `${this.formatTokens(metrics.totalOutputTokens)} output`
    );

    if (metrics.cacheCreateCount > 0 || metrics.totalCachedInputTokens > 0) {
      const cacheParts: string[] = [];
      if (metrics.cacheCreateCount > 0) {
        cacheParts.push(`${this.formatTokens(metrics.cacheCreateTokenCount)} created`);
      }
      if (metrics.totalCachedInputTokens > 0) {
        const reusedPercent = metrics.totalInputTokens > 0
          ? ` (${this.formatPercent(metrics.totalCachedInputTokens / metrics.totalInputTokens)})`
          : '';
        cacheParts.push(`${this.formatTokens(metrics.totalCachedInputTokens)}${reusedPercent} reused`);
      }
      if (metrics.cacheReferencedRuns > 0) {
        cacheParts.push(
          `${this.formatPercent(metrics.cacheHitRuns / metrics.cacheReferencedRuns)} hit rate ` +
          `(${metrics.cacheHitRuns}/${metrics.cacheReferencedRuns})`
        );
      }
      console.log(`    Cache: ${cacheParts.join(' • ')}`);
    }

    if (metrics.budgetContent.originalChars > 0) {
      const keptRatio = metrics.budgetContent.keptChars / metrics.budgetContent.originalChars;
      const removedChars = Math.max(0, metrics.budgetContent.originalChars - metrics.budgetContent.keptChars);
      console.log(
        `    Budget scale: ${this.formatPercent(keptRatio)} kept • ` +
        `${this.formatPercent(removedChars / metrics.budgetContent.originalChars)} removed ` +
        `(${this.formatTokens(metrics.budgetContent.keptChars)}/` +
        `${this.formatTokens(metrics.budgetContent.originalChars)} chars)`
      );
    }
  }

  private printItemSummary(): void {
    const { discovered, attempted, triaged, skipped, failed, stopReasons } = this.state.items;
    if (discovered + attempted + triaged + skipped + failed === 0) return;

    const itemParts: string[] = [];
    if (discovered > 0) itemParts.push(`${discovered} discovered`);
    if (attempted > 0) itemParts.push(`${attempted} attempted`);
    if (triaged > 0) itemParts.push(`✅ ${triaged} triaged`);
    if (skipped > 0) itemParts.push(`ℹ️ ${skipped} skipped`);
    if (failed > 0) itemParts.push(`❌ ${failed} failed`);
    console.log(`  Items: ${itemParts.join(' • ')}`);

    const flowParts: string[] = [];
    if (attempted > 0) {
      flowParts.push(`${this.formatPercent(triaged / attempted)} triaged rate`);
    }

    const fastRuns = this.state.modes.fast.runs.length;
    const proRuns = this.state.modes.pro.runs.length;
    if (fastRuns > 0) {
      flowParts.push(`${this.formatPercent(proRuns / fastRuns)} fast→pro escalation (${proRuns}/${fastRuns})`);
    }

    const stopReasonParts = Object.entries(stopReasons)
      .filter(([, count]) => count > 0)
      .map(([reason, count]) => `${STOP_REASON_LABELS[reason as StopReason]} ${count}`);
    if (stopReasonParts.length > 0) {
      flowParts.push(`stop reasons: ${stopReasonParts.join(', ')}`);
    }

    if (flowParts.length > 0) {
      console.log(`  Flow: ${flowParts.join(' • ')}`);
    }
  }

  private printActionSummary(): void {
    const totalActions = this.state.actions.details.length;
    if (totalActions === 0) return;

    const touchedIssues = new Set(this.state.actions.details.map((action) => action.issueNumber)).size;
    const actionBreakdown = ACTION_TYPES
      .map((type) => {
        const count = this.state.actions.counts[type];
        return count > 0 ? `${type} ${count}` : null;
      })
      .filter((value): value is string => value !== null);

    console.log(
      `  Actions: ${totalActions} total • ${touchedIssues} item(s) touched` +
      `${actionBreakdown.length > 0 ? ` • ${actionBreakdown.join(' • ')}` : ''}`
    );
  }

  printSummary(): void {
    console.log('\n' + chalk.bold('📊 Run Statistics:'));

    const { owner, repo } = this.state.context;
    if (owner && repo) {
      console.log(`  Repo: ${owner}/${repo}`);
    }
    console.log(`  Runtime: ${this.formatDuration(Date.now() - this.state.startedAt)}`);

    if (this.state.github.calls > 0 || this.state.github.retries > 0) {
      console.log(`  GitHub API: ${this.state.github.calls} calls • ${this.state.github.retries} retries`);
    }

    this.printItemSummary();
    this.printActionSummary();
    this.printModelSummary('Fast', 'fast');
    this.printModelSummary('Pro', 'pro');

    if (this.state.actions.details.length > 0) {
      console.log('\n' + chalk.bold('🎬 Actions Performed:'));

      const byIssue = new Map<number, ActionDetail[]>();
      for (const action of this.state.actions.details) {
        if (!byIssue.has(action.issueNumber)) {
          byIssue.set(action.issueNumber, []);
        }
        byIssue.get(action.issueNumber)!.push(action);
      }

      const sortedIssues = Array.from(byIssue.keys()).sort((a, b) => a - b);
      for (const issueNumber of sortedIssues) {
        const actions = byIssue.get(issueNumber)!;
        console.log(`  #${issueNumber}: ${actions.map((action) => action.details).join(', ')}`);
      }
    }
  }
}
