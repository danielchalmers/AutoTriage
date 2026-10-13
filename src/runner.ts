import * as core from '@actions/core';
import * as github from '@actions/github';
import { createHash } from 'node:crypto';
import { buildAnalysisResultSchema, normalizeRepoLabels } from './analysis';
import { BUILTIN_LABEL_ONLY_PROMPT, buildSystemPrompt } from './prompts';
import {
  buildAutoDiscoverQueue,
  filterPreviouslyTriagedClosedIssuesWithNewActivity,
} from './autoDiscover';
import { ModelError } from './llm/chat';
import { GitHubClient, Issue } from './github';
import { IssueProcessorDeps, processIssue } from './issueProcessor';
import type { Config } from './config';
import { TriageDb, readWorkspaceFile, saveDatabase, saveRunArtifact } from './storage';
import { classifyFailure, configurationHint, describeFailure } from './failures';
import { RunReport, annotateItems, writeJobSummary } from './summary';
import { errorDetail } from './util';
import { DEFAULT_PROMPT_PATH } from './env';

export type AutoTriageDeps = IssueProcessorDeps;

export interface ListTargetsDeps {
  cfg: Config;
  db: TriageDb;
  gh: Pick<GitHubClient, 'listOpenIssues' | 'listRecentlyClosedIssues'>;
  payload?: any;
}

// After this many items in a row fail, the cause is most likely an outage, so the run stops.
const MAX_CONSECUTIVE_FAILURES = 3;

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
  const report: RunReport = { policy: null, failures: [], warnings: [] };
  try {
    // A checked-out file wins, so a job can still supply its own. Otherwise the file is read at the run's commit, which is what a checkout would have given.
    const ref = github.context.sha || undefined;
    const policy = readWorkspaceFile(cfg.promptPath) ?? await gh.readFile(cfg.promptPath, ref);
    if (policy === undefined) {
      if (cfg.promptPath !== DEFAULT_PROMPT_PATH) {
        fail(report, `Triage didn't start: prompt-path '${cfg.promptPath}' isn't in the repository. Check the path.`);
        return;
      }
      console.log(`📜 Using the built-in label-only policy, because the repository has no ${DEFAULT_PROMPT_PATH}`);
    } else {
      report.policy = cfg.promptPath;
    }
    const readme = readWorkspaceFile('README.md') ?? await gh.readReadme(ref);
    await triageTargets(deps, report, policy ?? BUILTIN_LABEL_ONLY_PROMPT, readme);
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
    stats.setGithubApiCalls(gh.getApiCallCount());
    stats.printSummary();
    saveRunArtifact('run-summary.json', JSON.stringify(stats.toJSON(), null, 2));
    annotateItems(stats.getItems(), report.warnings.length);
    await writeJobSummary(cfg, stats, report);
  }
}

async function triageTargets(deps: AutoTriageDeps, report: RunReport, policy: string, readme: string): Promise<void> {
  const { cfg, db, gh, model, stats } = deps;
  const repoLabels = normalizeRepoLabels(await gh.listRepoLabels());
  const { targets, autoDiscover } = await listTargets({ cfg, db, gh });
  stats.setDiscovered(targets.length);
  const runTimestamp = new Date().toISOString();
  let runsPerformed = 0;
  let consecutiveFailures = 0;
  const bugs: string[] = [];

  console.log(`⚙️ Running in ${cfg.dryRun ? 'dry-run' : 'live'} mode`);
  console.log(autoDiscover
    ? `▶️ Discovered ${targets.length} item(s) from ${cfg.owner}/${cfg.repo}`
    : `▶️ Triaging ${targets.length} item(s): ${targets.map((n) => `#${n}`).join(', ')}`);
  console.log(`⏳ Runs limited to ${cfg.maxRuns} item(s)`);

  const systemPrompt = buildSystemPrompt(policy, readme, repoLabels, cfg.additionalInstructions, cfg.limits);
  saveRunArtifact('prompt-system.md', systemPrompt);

  stats.setPromptHash(hashPrompt(systemPrompt));

  const itemDeps = { cfg, db, gh, model, stats };
  const itemOptions = { repoLabels, schema: buildAnalysisResultSchema(repoLabels), autoDiscover, systemPrompt, runTimestamp };

  for (const [index, issueNumber] of targets.entries()) {
    let issue: Issue | undefined;
    let reanalyzed = false;
    // Every attempt spends max-runs, a failed one too, so items that fail between successes can't stretch a run past it.
    runsPerformed++;
    try {
      issue = await gh.getIssue(issueNumber);
      let record = await processIssue(itemDeps, { ...itemOptions, issue });
      // An item that changed during analysis gets one more analysis with its latest state, if max-runs allows it.
      // It runs from here so that the first analysis's log group is closed, because log groups don't nest.
      if (record.changedDuringAnalysis) {
        if (runsPerformed >= cfg.maxRuns) {
          console.log(`⏳ #${issueNumber} isn't analyzed again, because the run reached max-runs (${cfg.maxRuns})`);
        } else {
          console.log(`🔁 Analyzing #${issueNumber} again, because it changed while it was being analyzed`);
          reanalyzed = true;
          runsPerformed++;
          issue = await gh.getIssue(issueNumber);
          record = await processIssue(itemDeps, { ...itemOptions, issue, reanalysis: true });
        }
      }
      stats.recordItem(record);
      consecutiveFailures = 0;
      saveDatabase(db, cfg.dbPath, cfg.dryRun);
    } catch (err) {
      // Any per-item failure is recorded and skipped so one bad item can't abort the remaining backlog.
      // A configuration error, such as a rejected key or a missing permission, would fail every later item too, so it stops the run and fails the job at once.
      // The consecutive-failure breaker below still stops the run if errors cascade, as in an outage.
      const failure = classifyFailure(err);
      const detail = describeFailure(err);
      stats.recordItem({
        issueNumber,
        type: issue?.type,
        title: issue?.title,
        outcome: 'failed',
        ...(reanalyzed ? { reanalyzed } : {}),
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
    }

    if (runsPerformed >= cfg.maxRuns) {
      const remaining = targets.slice(index + 1);
      console.log(`⏳ Reached max-runs (${cfg.maxRuns}) with ${remaining.length} item(s) remaining`);
      stats.setCapReached();
      report.notReached = { items: remaining, reason: `the run reached max-runs (${cfg.maxRuns})` };
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
  if (cfg.issueNumbers) return { targets: cfg.issueNumbers, autoDiscover: false };

  const payload = deps.payload ?? github.context.payload;
  const payloadNumber = payload?.issue?.number || payload?.pull_request?.number;
  if (payloadNumber) return { targets: [Number(payloadNumber)], autoDiscover: false };

  const issues = await gh.listOpenIssues();
  const recentlyClosedIssues = await gh.listRecentlyClosedIssues();
  const closedIssuesToRecheck = filterPreviouslyTriagedClosedIssuesWithNewActivity(recentlyClosedIssues, db);
  const orderedNumbers = buildAutoDiscoverQueue(issues.concat(closedIssuesToRecheck), db);
  return { targets: orderedNumbers, autoDiscover: true };
}
