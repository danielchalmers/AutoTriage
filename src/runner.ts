import * as core from '@actions/core';
import * as github from '@actions/github';
import { createHash } from 'node:crypto';
import {
  buildSystemPrompt,
  normalizeRepoLabels,
} from './analysis';
import {
  buildAutoDiscoverQueue,
  filterPreviouslyTriagedClosedIssuesWithNewActivity,
} from './autoDiscover';
import { ModelError } from './llm/chat';
import { GitHubClient, Issue } from './github';
import { IssueProcessorDeps, PassError, processIssue } from './issueProcessor';
import type { ItemRecord, RunStatistics } from './stats';
import type { Config } from './config';
import { TriageDb, hasPromptFile, saveDatabase, saveRunArtifact } from './storage';
import { classifyFailure, configurationHint, describeFailure } from './failures';
import { RunReport, annotateItems, writeJobSummary } from './summary';
import { errorDetail } from './util';

export type AutoTriageDeps = IssueProcessorDeps;

export interface ListTargetsDeps {
  cfg: Config;
  db: TriageDb;
  gh: Pick<GitHubClient, 'listOpenIssues' | 'listRecentlyClosedIssues'>;
  payload?: any;
}

// After this many items in a row fail, the cause is most likely an outage, so the run stops.
const MAX_CONSECUTIVE_FAILURES = 3;

// Every run cap is reported the same way: log the remaining backlog, stamp which cap stopped the run, and list what it didn't reach.
function reportCapReached(stats: RunStatistics, report: RunReport, mode: 'fast' | 'pro', maxRuns: number, remaining: number[]): void {
  console.log(`⏳ Max ${mode} runs (${maxRuns}) reached with ${remaining.length} item(s) remaining`);
  stats.setCapReached(mode);
  report.notReached = { items: remaining, reason: `the run reached max-${mode}-runs (${maxRuns})` };
}

// A failure fails the job at once, and the job summary repeats it.
function fail(report: RunReport, message: string): void {
  report.failures.push(message);
  core.setFailed(message);
}

function warn(report: RunReport, message: string): void {
  report.warnings.push(message);
  core.warning(message);
}


// Truncated content hash so run summaries can be segmented by prompt version.
function hashPrompt(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * Triages the run's targets, then reports on the run in the log, the run-summary.json artifact, warning annotations and the job summary.
 * The job fails only for a configuration error or a bug. Model failures, deferred items and GitHub's own failures only warn.
 */
export async function runAutoTriage(deps: AutoTriageDeps): Promise<void> {
  const { cfg, gh, stats } = deps;
  const report: RunReport = { policy: hasPromptFile(cfg.promptPath) ? cfg.promptPath : null, failures: [], warnings: [] };
  try {
    await triageTargets(deps, report);
  } catch (err) {
    // Only a failure outside an item gets here, such as listing the repository's labels or its backlog.
    const failure = classifyFailure(err);
    if (failure === 'external') {
      warn(report, `Triage didn't start: ${describeFailure(err)}`);
    } else if (failure === 'configuration') {
      fail(report, `Triage didn't start: ${describeFailure(err)}${configurationHint(err)}`);
    } else {
      console.error(errorDetail(err));
      fail(report, `Triage stopped because of a bug in AutoTriage, and the log has the stack. ${describeFailure(err)}`);
    }
  } finally {
    // Emit run telemetry even when the run aborts, so failed runs remain researchable.
    stats.incrementGithubApiCalls(gh.getApiCallCount());
    stats.printSummary();
    saveRunArtifact('run-summary.json', JSON.stringify(stats.toJSON(), null, 2));
    annotateItems(stats.getItems(), report.warnings.length);
    await writeJobSummary(cfg, stats, report);
  }
}

async function triageTargets(deps: AutoTriageDeps, report: RunReport): Promise<void> {
  const { cfg, db, gh, models, stats } = deps;
  const repoLabels = normalizeRepoLabels(await gh.listRepoLabels());
  const { targets, autoDiscover } = await listTargets({ cfg, db, gh });
  stats.setDiscovered(targets.length);
  const runTimestamp = new Date().toISOString();
  let triagesPerformed = 0;
  let fastRunsPerformed = 0;
  let consecutiveFailures = 0;
  const bugs: string[] = [];

  console.log(`⚙️ Running in ${cfg.dryRun ? 'dry-run' : 'live'} mode`);
  console.log(autoDiscover
    ? `▶️ Discovered ${targets.length} item(s) from ${cfg.owner}/${cfg.repo} (extended: ${cfg.extended})`
    : `▶️ Triaging ${targets.length} item(s): ${targets.map((n) => `#${n}`).join(', ')}`);
  console.log(`⏳ Fast runs limited to ${cfg.maxFastRuns} item(s), Pro runs limited to ${cfg.maxProRuns} item(s)`);

  const systemPromptFast = cfg.skipFastPass
    ? ''
    : buildSystemPrompt(cfg.promptPath, cfg.readmePath, repoLabels, cfg.additionalInstructions, 'fast', cfg.limits.fast);
  const systemPromptPro = buildSystemPrompt(
    cfg.promptPath,
    cfg.readmePath,
    repoLabels,
    cfg.additionalInstructions,
    'pro',
    cfg.limits.pro
  );
  if (!cfg.skipFastPass) saveRunArtifact('prompt-system-fast.md', systemPromptFast);
  saveRunArtifact('prompt-system.md', systemPromptPro);

  stats.setRunConfig({
    dryRun: cfg.dryRun,
    extended: cfg.extended,
    skipFastPass: cfg.skipFastPass,
    maxFastRuns: cfg.maxFastRuns,
    maxProRuns: cfg.maxProRuns,
  });
  stats.setPromptHashes({
    fast: cfg.skipFastPass ? null : hashPrompt(systemPromptFast),
    pro: hashPrompt(systemPromptPro),
  });


  // The pass budget that's used up, if any, which leaves no room for another analysis.
  const spentBudget = (): 'fast' | 'pro' | undefined => {
    if (!cfg.skipFastPass && fastRunsPerformed >= cfg.maxFastRuns) return 'fast';
    if (triagesPerformed >= cfg.maxProRuns) return 'pro';
    return undefined;
  };
  const maxRuns = (mode: 'fast' | 'pro') => (mode === 'fast' ? cfg.maxFastRuns : cfg.maxProRuns);
  // A finished analysis spends the review budget when its review pass ran, and the fast budget when its fast pass ran, which is when it has a fastPlan.
  const spend = (record: ItemRecord) => {
    if (record.escalatedToPro) triagesPerformed++;
    if (record.fastPlan) fastRunsPerformed++;
  };
  const itemDeps = { cfg, db, gh, models, stats };
  const itemOptions = { repoLabels, autoDiscover, systemPromptFast, systemPromptPro, runTimestamp };

  for (const [index, issueNumber] of targets.entries()) {
    const spent = spentBudget();
    if (spent) {
      reportCapReached(stats, report, spent, maxRuns(spent), targets.slice(index));
      break;
    }

    let issue: Issue | undefined;
    let reanalyzed = false;
    try {
      issue = await gh.getIssue(issueNumber);
      let record = await processIssue(itemDeps, { ...itemOptions, issue });
      spend(record);
      // An item that changed during analysis gets one more analysis with its latest state, if the budgets allow it.
      // It runs from here so that the first analysis's log group is closed, because log groups don't nest.
      if (record.changedDuringAnalysis) {
        const spentNow = spentBudget();
        if (spentNow) {
          console.log(`⏳ #${issueNumber} isn't analyzed again, because the run reached max-${spentNow}-runs (${maxRuns(spentNow)})`);
        } else {
          console.log(`🔁 Analyzing #${issueNumber} again, because it changed while it was being analyzed`);
          reanalyzed = true;
          issue = await gh.getIssue(issueNumber);
          record = await processIssue(itemDeps, { ...itemOptions, issue, reanalysis: true });
          spend(record);
        }
      }
      stats.recordItem(record);
      consecutiveFailures = 0;
    } catch (thrown) {
      // Any per-item failure is recorded and skipped so one bad item can't abort the remaining backlog.
      // A configuration error, such as a rejected key or a missing permission, would fail every later item too, so it stops the run and fails the job at once.
      // The consecutive-failure breaker below still stops the run if errors cascade, as in an outage.
      const failedPass = thrown instanceof PassError ? thrown.pass : undefined;
      const err = thrown instanceof PassError ? thrown.cause : thrown;
      const failure = classifyFailure(err);
      const detail = describeFailure(err);
      stats.recordItem({
        issueNumber,
        type: issue?.type,
        title: issue?.title,
        outcome: 'failed',
        escalatedToPro: failedPass === 'pro',
        ...(reanalyzed ? { reanalyzed } : {}),
        failedPass,
        failureReason: err instanceof ModelError ? err.kind : 'other',
        detail,
      });
      if (failure === 'configuration') {
        fail(report, `Stopped the run at #${issueNumber}, because every later item would fail the same way: ${detail}${configurationHint(err)}`);
        report.notReached = { items: targets.slice(index + 1), reason: 'the run stopped on a configuration error' };
        break;
      }
      // An expected failure, such as a model or GitHub error, is logged without a stack. A bug's stack says where to look.
      if (failure === 'bug') {
        console.warn(`#${issueNumber}: unexpected error: ${errorDetail(err)}`);
        bugs.push(`#${issueNumber}: ${detail}`);
      } else {
        console.warn(`#${issueNumber}: ${detail}`);
      }
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        const remaining = targets.slice(index + 1);
        warn(report, `Stopped the run after ${consecutiveFailures} items in a row failed, so ${remaining.length} item(s) weren't attempted.`);
        report.notReached = { items: remaining, reason: `${consecutiveFailures} items in a row failed` };
        break;
      }
      continue;
    }

    saveDatabase(db, cfg.dbPath, cfg.dryRun);

    if (triagesPerformed >= cfg.maxProRuns) {
      reportCapReached(stats, report, 'pro', cfg.maxProRuns, targets.slice(index + 1));
      break;
    }
  }

  if (bugs.length > 0) {
    fail(report, `${bugs.length} item(s) failed because of a bug in AutoTriage, and the log has the stack for each. ${bugs.join('; ')}`);
  }
}

export async function listTargets(
  deps: ListTargetsDeps
): Promise<{ targets: number[]; autoDiscover: boolean }> {
  const { cfg, db, gh } = deps;
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return { targets: fromInput, autoDiscover: false };

  const payload = deps.payload ?? github.context.payload;
  const payloadNumber = payload?.issue?.number || payload?.pull_request?.number;
  if (payloadNumber) return { targets: [Number(payloadNumber)], autoDiscover: false };

  const issues = await gh.listOpenIssues();
  const recentlyClosedIssues = cfg.extended ? await gh.listRecentlyClosedIssues() : [];
  const closedIssuesToRecheck = filterPreviouslyTriagedClosedIssuesWithNewActivity(recentlyClosedIssues, db);
  const skipUnchanged = !cfg.extended;
  const orderedNumbers = buildAutoDiscoverQueue(issues.concat(closedIssuesToRecheck), db, skipUnchanged);
  return { targets: orderedNumbers, autoDiscover: true };
}
