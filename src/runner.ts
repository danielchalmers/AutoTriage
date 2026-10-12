import * as core from '@actions/core';
import { createHash } from 'node:crypto';
import { buildAnalysisResultSchema, normalizeRepoLabels } from './analysis';
import { POLICY_PATH, PromptSources, buildSystemPrompt, readPromptSources } from './prompts';
import {
  MAX_SWEEP_ITEMS,
  buildAutoDiscoverQueue,
  filterPreviouslyTriagedClosedIssuesWithNewActivity,
} from './autoDiscover';
import { ModelError } from './llm/chat';
import { GitHubClient, Issue, describeRef } from './github';
import { EventGitHub, TriggerEvent, currentEvent, resolveEventTarget } from './event';
import { IssueProcessorDeps, processIssue } from './issueProcessor';
import type { Config } from './config';
import { TriageDb, saveDatabase, saveRunArtifact } from './storage';
import { classifyFailure, configurationHint, describeFailure } from './failures';
import { RunReport, annotateItems, writeJobSummary } from './summary';
import { errorDetail } from './util';

export type AutoTriageDeps = IssueProcessorDeps;

export interface ListTargetsDeps {
  cfg: Config;
  db: TriageDb;
  gh: Pick<GitHubClient, 'listOpenIssues' | 'listRecentlyClosedIssues'> & EventGitHub;
  // True when the repository has a policy file, so a sweep also revisits unchanged items and recently closed ones with new activity.
  // The built-in label-only policy has nothing to add to an item that hasn't changed, so without a policy file a sweep takes only new and changed items.
  revisit: boolean;
  // The event from the workflow's context when left out.
  event?: TriggerEvent;
}

export interface Targets {
  targets: number[];
  autoDiscover: boolean;
  // How many more items a sweep found than MAX_SWEEP_ITEMS, which wait for the next sweep.
  leftForNextSweep?: number;
  // How the pull request behind a workflow_run event was found, such as "PR #12 (listed on the workflow run)".
  via?: string;
  // Why the run has nothing to triage.
  notice?: string;
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

function note(report: RunReport, message: string): void {
  report.notices.push(message);
  core.notice(message);
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
  const report: RunReport = { failures: [], warnings: [], notices: [] };
  try {
    await triageTargets(deps, report);
  } catch (err) {
    // Only a failure outside an item gets here, such as reading the policy, finding the event's pull request or listing the repository's labels or its backlog.
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

/**
 * Reads the policy and README at the run's commit, and says where they came from in the log and the job summary.
 * A transient GitHub failure stops the run with a warning and returns undefined, because the built-in policy must not stand in for a policy file that exists but couldn't be read.
 */
async function readSources(gh: AutoTriageDeps['gh'], sha: string | undefined, report: RunReport): Promise<PromptSources | undefined> {
  const at = describeRef(sha);
  let sources: PromptSources;
  try {
    sources = await readPromptSources(gh, sha);
  } catch (err) {
    if (classifyFailure(err) !== 'external') throw err;
    warn(report, `Triage didn't start, because the policy and README couldn't be read at ${at}, and the built-in policy doesn't stand in for a policy file that failed to load: ${describeFailure(err)}`);
    return undefined;
  }
  report.sources = { at, policy: sources.policy === null ? null : POLICY_PATH, readme: sources.readme?.name ?? null };
  console.log(`📜 Policy: ${sources.policy === null ? 'built-in' : `${POLICY_PATH} at ${at}`}`);
  console.log(`📖 README: ${sources.readme ? `${sources.readme.name} at ${at}` : 'none'}`);
  return sources;
}

async function triageTargets(deps: AutoTriageDeps, report: RunReport): Promise<void> {
  const { cfg, db, gh, model, stats } = deps;
  const sources = await readSources(gh, cfg.sha, report);
  if (!sources) return;
  const revisit = sources.policy !== null;
  const { targets, autoDiscover, leftForNextSweep = 0, via, notice } = await listTargets({ cfg, db, gh, revisit });
  const discovered = targets.length + leftForNextSweep;
  stats.setDiscovered(discovered, leftForNextSweep);
  if (via) {
    console.log(`🔗 workflow_run event: ${via}`);
    report.workflowRun = via;
  }
  // An event with nothing to triage ends the run here, green, before it reads the labels.
  if (notice) {
    note(report, notice);
    return;
  }
  const repoLabels = normalizeRepoLabels(await gh.listRepoLabels());
  const runTimestamp = new Date().toISOString();
  let consecutiveFailures = 0;
  const bugs: string[] = [];

  console.log(`⚙️ Running in ${cfg.dryRun ? 'dry-run' : 'live'} mode`);
  if (autoDiscover) {
    const scope = revisit ? 'new, changed and unchanged items, because the repository has a policy file' : 'new and changed items only, because the built-in policy applies';
    console.log(`▶️ Discovered ${discovered} item(s) from ${cfg.owner}/${cfg.repo}: ${scope}`);
    if (leftForNextSweep > 0) console.log(`⏳ A sweep triages at most ${MAX_SWEEP_ITEMS} items, so ${leftForNextSweep} are left for the next sweep`);
  } else {
    console.log(`▶️ Triaging ${targets.length} item(s): ${targets.map((n) => `#${n}`).join(', ')}`);
  }

  const systemPrompt = buildSystemPrompt(sources.policy, sources.readme?.text ?? null, repoLabels);
  saveRunArtifact('prompt-system.md', systemPrompt);

  stats.setRunConfig({ dryRun: cfg.dryRun });
  stats.setPromptHash(hashPrompt(systemPrompt));

  const itemDeps = { cfg, db, gh, model, stats };
  const itemOptions = { repoLabels, schema: buildAnalysisResultSchema(repoLabels), autoDiscover, systemPrompt, runTimestamp };

  for (const [index, issueNumber] of targets.entries()) {
    let issue: Issue | undefined;
    let reanalyzed = false;
    try {
      issue = await gh.getIssue(issueNumber);
      let record = await processIssue(itemDeps, { ...itemOptions, issue });
      // An item that changed during analysis gets one more analysis with its latest state, and it still counts as one item of the run.
      // It runs from here so that the first analysis's log group is closed, because log groups don't nest.
      if (record.changedDuringAnalysis) {
        console.log(`🔁 Analyzing #${issueNumber} again, because it changed while it was being analyzed`);
        reanalyzed = true;
        issue = await gh.getIssue(issueNumber);
        record = await processIssue(itemDeps, { ...itemOptions, issue, reanalysis: true });
      }
      stats.recordItem(record);
      consecutiveFailures = 0;
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
      continue;
    }

    saveDatabase(db, cfg.dryRun);
  }

  if (bugs.length > 0) {
    fail(report, `${bugs.length} item(s) failed because of a bug in AutoTriage, and the log has the stack for each. ${bugs.join('; ')}`);
  }
}

/**
 * The run's targets: a non-blank issues input, else the item the event names, else the pull request behind a workflow_run event, else a backlog sweep on schedule, workflow_dispatch or a local run.
 * An issues input runs in full, while a sweep takes at most MAX_SWEEP_ITEMS from the front of its queue.
 * Any other event triages nothing and says so in a notice.
 */
export async function listTargets(deps: ListTargetsDeps): Promise<Targets> {
  const { cfg, db, gh, revisit } = deps;
  if (cfg.issueNumbers?.length) return { targets: cfg.issueNumbers, autoDiscover: false };

  const target = await resolveEventTarget(deps.event ?? currentEvent(), gh);
  if (target.kind === 'none') return { targets: [], autoDiscover: false, notice: target.notice };
  if (target.kind === 'item') return { targets: [target.number], autoDiscover: false, ...(target.via ? { via: target.via } : {}) };

  const issues = await gh.listOpenIssues();
  const recentlyClosedIssues = revisit ? await gh.listRecentlyClosedIssues() : [];
  const closedIssuesToRecheck = filterPreviouslyTriagedClosedIssuesWithNewActivity(recentlyClosedIssues, db);
  const queue = buildAutoDiscoverQueue(issues.concat(closedIssuesToRecheck), db, revisit);
  const targets = queue.slice(0, MAX_SWEEP_ITEMS);
  return { targets, autoDiscover: true, leftForNextSweep: queue.length - targets.length };
}
