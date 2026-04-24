import chalk from 'chalk';

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

export class RunStatistics {
  private fastRuns: ModelRunStats[] = [];
  private proRuns: ModelRunStats[] = [];
  private cacheCreates: CacheCreateStats[] = [];
  private actionsPerformed: ActionDetail[] = [];
  private triaged = 0;
  private skipped = 0;
  private failed = 0;
  private githubApiCalls = 0;
  private owner = '';
  private repo = '';
  private modelFast = '';
  private modelPro = '';

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
    const cacheHitRuns = runs.filter(r => (r.cachedInputTokens ?? 0) > 0).length;
    const cacheReferencedRuns = runs.filter(r => r.cacheName).length;

    return {
      total,
      avg,
      p95,
      inputTokens,
      outputTokens,
      cachedInputTokens,
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
      `    Tokens used: ${this.formatTokens(stats.inputTokens)} input ` +
      `(${this.formatTokens(stats.cachedInputTokens)} cached` +
      `${stats.inputTokens > 0 && stats.cachedInputTokens > 0
        ? `, ${this.formatPercent(stats.cachedInputTokens / stats.inputTokens)}`
        : ''}), ` +
      `${this.formatTokens(stats.outputTokens)} output`
    );

    const cacheCreate = this.getCacheCreateStats(mode);
    if (cacheCreate.count > 0 || stats.cacheHitRuns > 0 || stats.cacheReferencedRuns > 0) {
      const cacheAttempts = stats.cacheReferencedRuns || runs.length;
      const cacheParts = [
        `${this.formatPercent(stats.cacheHitRuns / cacheAttempts)} hit rate (${stats.cacheHitRuns}/${cacheAttempts})`,
      ];
      if (stats.cachedInputTokens > 0) {
        cacheParts.push(`${this.formatTokens(stats.cachedInputTokens)} reused`);
      }
      if (cacheCreate.count > 0) {
        cacheParts.push(`${this.formatTokens(cacheCreate.tokenCount)} created`);
      }
      console.log(`    Cache: ${cacheParts.join(' • ')}`);
    }
  }

  printSummary(): void {
    console.log('\n' + chalk.bold('📊 Run Statistics:'));

    if (this.githubApiCalls > 0) {
      console.log(`  GitHub API calls: ${this.githubApiCalls}`);
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
}
