import chalk from 'chalk';

export interface ModelRunStats {
  startTime: number;
  endTime: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ActionDetail {
  issueNumber: number;
  type: 'labels' | 'comment' | 'title' | 'state';
  details: string;
}

export class RunStatistics {
  private fastRuns: ModelRunStats[] = [];
  private proRuns: ModelRunStats[] = [];
  private actionsPerformed: ActionDetail[] = [];
  private triaged = 0;
  private skipped = 0;
  private failed = 0;
  private githubApiCalls = 0;

  trackFastRun(stats: ModelRunStats): void {
    this.fastRuns.push(stats);
  }

  trackProRun(stats: ModelRunStats): void {
    this.proRuns.push(stats);
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

  private calculateStats(runs: ModelRunStats[]): {
    total: number;
    avg: number;
    p95: number;
    inputTokens: number;
    outputTokens: number;
  } {
    if (runs.length === 0) {
      return { total: 0, avg: 0, p95: 0, inputTokens: 0, outputTokens: 0 };
    }

    const durations = runs.map(r => r.endTime - r.startTime);
    const total = durations.reduce((sum, d) => sum + d, 0);
    const avg = total / runs.length;
    const sorted = [...durations].sort((a, b) => a - b);
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
    const p95 = sorted[p95Index] ?? 0;
    const inputTokens = runs.reduce((sum, r) => sum + r.inputTokens, 0);
    const outputTokens = runs.reduce((sum, r) => sum + r.outputTokens, 0);

    return { total, avg, p95, inputTokens, outputTokens };
  }

  printSummary(): void {
    console.log('\n' + chalk.bold('📊 Run Statistics:'));

    // Fast model stats
    if (this.fastRuns.length > 0) {
      const stats = this.calculateStats(this.fastRuns);
      console.log(chalk.cyan('  Fast'));
      console.log(
        `    Total: ${this.formatDuration(stats.total)} • ` +
        `Avg: ${this.formatDuration(stats.avg)} • ` +
        `p95: ${this.formatDuration(stats.p95)}`
      );
      console.log(
        `    Tokens used: ${this.formatTokens(stats.inputTokens)} input, ` +
        `${this.formatTokens(stats.outputTokens)} output`
      );
    }

    // Pro model stats
    if (this.proRuns.length > 0) {
      const stats = this.calculateStats(this.proRuns);
      console.log(chalk.cyan('  Pro'));
      console.log(
        `    Total: ${this.formatDuration(stats.total)} • ` +
        `Avg: ${this.formatDuration(stats.avg)} • ` +
        `p95: ${this.formatDuration(stats.p95)}`
      );
      console.log(
        `    Tokens used: ${this.formatTokens(stats.inputTokens)} input, ` +
        `${this.formatTokens(stats.outputTokens)} output`
      );
    }

    // Actions summary
    const actionParts: string[] = [];
    if (this.triaged > 0) actionParts.push(`✅ ${this.triaged} triaged`);
    if (this.skipped > 0) actionParts.push(`ℹ️ ${this.skipped} skipped`);
    if (this.failed > 0) actionParts.push(`❌ ${this.failed} failed`);
    
    if (actionParts.length > 0) {
      console.log(`  Actions performed: ${actionParts.join(', ')}`);
    }

    // GitHub API calls
    if (this.githubApiCalls > 0) {
      console.log(`  GitHub API calls: ${this.githubApiCalls}`);
    }

    // Detailed actions list
    if (this.actionsPerformed.length > 0) {
      console.log('\n' + chalk.bold('📋 Summary of Actions Performed:'));
      
      // Group actions by issue number
      const byIssue = new Map<number, ActionDetail[]>();
      for (const action of this.actionsPerformed) {
        if (!byIssue.has(action.issueNumber)) {
          byIssue.set(action.issueNumber, []);
        }
        byIssue.get(action.issueNumber)!.push(action);
      }

      // Sort by issue number
      const sortedIssues = Array.from(byIssue.keys()).sort((a, b) => a - b);
      
      for (const issueNumber of sortedIssues) {
        const actions = byIssue.get(issueNumber)!;
        const parts = actions.map(a => a.details);
        console.log(`  #${issueNumber}: ${parts.join(', ')}`);
      }
    }
  }
}
