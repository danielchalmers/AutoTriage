import { color } from './util';
import * as core from '@actions/core';
import { RepoLabel, parseAnalysisResult } from './analysis';
import { buildUserPrompt } from './prompts';
import { errorMessage, type ChatClient, type JsonRequest } from './llm/chat';
import { GitHubClient, Issue, TimelineEvent } from './github';
import { ItemRecord, RunStatistics, describeModelRun, summarizePlan } from './stats';
import { PlannedOperation, describeOperation, executeOperations, explainPlan, planOperations } from './triage';
import type { Config } from './config';
import { TriageDb, getDbEntry, saveArtifact, updateDbEntry } from './storage';
import { parseTimestamp } from './util';

export type ModelClient = Pick<ChatClient, 'generateJson'>;

export interface IssueProcessorDeps {
  cfg: Config;
  db: TriageDb;
  gh: GitHubClient;
  model: ModelClient;
  stats: RunStatistics;
}

export interface ProcessIssueOptions {
  issue: Issue;
  repoLabels: RepoLabel[];
  // The response schema, which the runner builds once from the repository's labels.
  schema: JsonRequest['schema'];
  autoDiscover: boolean;
  systemPrompt: string;
  runTimestamp: string;
  // True when the runner analyzes the item again because it changed during its first analysis.
  reanalysis?: boolean;
}

interface Deferral {
  // True when the item changed during analysis, rather than when it couldn't be rechecked.
  changed: boolean;
  detail: string;
}

// Triages one item and returns its record for the run summary.
export async function processIssue(
  deps: IssueProcessorDeps,
  options: ProcessIssueOptions
): Promise<ItemRecord> {
  const { cfg, db, gh, model, stats } = deps;
  const { issue, repoLabels, schema, autoDiscover, systemPrompt, runTimestamp, reanalysis = false } = options;

  return core.group(`🤖 #${issue.number} ${issue.title}${reanalysis ? ' (re-analysis)' : ''}`, async (): Promise<ItemRecord> => {
    const { raw, filtered } = await gh.listTimelineEvents(issue.number, cfg.limits.timelineEvents, issue.type === 'pull request');
    saveArtifact(issue.number, 'timeline.json', JSON.stringify(raw, null, 2));
    const runContext = buildRunContext(issue, raw, getDbEntry(db, issue.number).lastTriaged, autoDiscover);
    const userPrompt = buildUserPrompt(issue, filtered, cfg.limits, runContext, runTimestamp);
    saveArtifact(issue.number, 'prompt-user.md', userPrompt);

    // It says "asking" rather than "thinking", because some providers report no reasoning.
    console.log(color('blue', `💭 Asking ${cfg.model.model}...`));
    const startTime = Date.now();
    const { data: analysis, ...usage } = await model.generateJson({ model: cfg.model.model, systemPrompt, userPrompt, schema }, parseAnalysisResult);
    const modelRun = { startTime, endTime: Date.now(), ...usage, issueNumber: issue.number };
    console.log(color('blue', describeModelRun(modelRun)));
    stats.trackModelRun(modelRun);

    // The plan's summary and the policy clause each operation cites say why, in the log and the hidden comment block.
    const explanation = explainPlan(analysis);
    console.log(color('magenta', explanation));
    saveArtifact(issue.number, 'analysis.json', JSON.stringify(analysis, null, 2));
    const operations = planOperations(issue, analysis, repoLabels.map((label) => label.name), explanation);

    const deferral = await executePlannedOperations({ cfg, gh, stats }, { issue, operations, reanalysis });
    const item = { issueNumber: issue.number, type: issue.type, title: issue.title, ...(reanalysis ? { reanalyzed: true } : {}), plan: summarizePlan(operations) };
    if (deferral) {
      return { ...item, outcome: 'deferred', detail: deferral.detail, ...(deferral.changed ? { changedDuringAnalysis: true } : {}) };
    }

    const consumedIssue = await resolveConsumedIssue(gh, cfg.dryRun, issue, operations);
    updateDbEntry(db, issue.number, getConsumedUpdatedAt(consumedIssue));
    return { ...item, outcome: 'triaged' };
  });
}

async function resolveConsumedIssue(
  gh: GitHubClient,
  dryRun: boolean,
  issue: Issue,
  operations: PlannedOperation[]
): Promise<Issue> {
  if (dryRun || operations.length === 0) {
    return issue;
  }

  try {
    return await gh.getIssue(issue.number);
  } catch (err) {
    console.warn(
      `⚠️ Failed to refresh #${issue.number} after applying operations: ${errorMessage(err)}. ` +
      'Using the pre-action updated_at watermark.'
    );
    return issue;
  }
}

function getConsumedUpdatedAt(issue: Pick<Issue, 'updated_at' | 'created_at'>): string | undefined {
  return issue.updated_at || issue.created_at;
}

// Applies the plan, or returns why it was deferred instead.
async function executePlannedOperations(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'gh' | 'stats'>,
  options: {
    issue: Issue;
    operations: PlannedOperation[];
    reanalysis: boolean;
  }
): Promise<Deferral | undefined> {
  const { cfg, gh, stats } = deps;
  const { issue, operations, reanalysis } = options;

  // Saved even when empty, so a re-analysis that plans nothing replaces the plan an earlier analysis deferred.
  saveArtifact(issue.number, 'operations.json', JSON.stringify(operations, null, 2));
  if (operations.length === 0) {
    console.log(color('yellow', 'The model planned no operations.'));
    return undefined;
  }

  if (!cfg.dryRun) {
    const plan = operations.map(describeOperation).join(', ');
    // The deferred plan is logged, because a re-analysis replaces the item's artifacts.
    const deferring = `Deferring its planned operations: ${plan}.`;
    try {
      const currentIssue = await gh.getIssue(issue.number);
      const analyzedUpdatedAt = getConsumedUpdatedAt(issue);
      const currentUpdatedAt = getConsumedUpdatedAt(currentIssue);
      if (currentUpdatedAt !== analyzedUpdatedAt) {
        console.warn(
          `⚠️ #${issue.number} changed while it was being analyzed (updated at ${analyzedUpdatedAt}, now ${currentUpdatedAt}). ${deferring}`
        );
        // The summary says how to recover and what was skipped, because an event run has no sweep to pick the item up later.
        // The plan goes last, since the summary truncates long reasons.
        return {
          changed: true,
          detail: `${reanalysis ? 'It changed again while it was being re-analyzed' : 'It changed while it was being analyzed'}, so its plan wasn't applied. Re-run the job to triage it now. The plan was: ${plan}.`,
        };
      }
    } catch (err) {
      console.warn(`⚠️ Failed to recheck #${issue.number} before applying operations: ${errorMessage(err)}. ${deferring}`);
      return {
        changed: false,
        detail: `It couldn't be rechecked before applying the plan, so the plan wasn't applied: ${errorMessage(err)}`,
      };
    }
  }

  await executeOperations(operations, {
    issue,
    dryRun: cfg.dryRun,
    gh,
    onAction: (op) => {
      stats.trackAction({
        issueNumber: issue.number,
        type: op.kind,
        details: describeOperation(op),
      });
    },
  });
  return undefined;
}

// The later of the item's own update time and its newest dated timeline event.
function latestActivityMs(issue: Issue, timelineEvents: TimelineEvent[]): number {
  return timelineEvents.reduce((latest, event) => Math.max(latest, parseTimestamp(event.created_at)), parseTimestamp(issue.updated_at));
}

export function buildRunContext(
  issue: Issue,
  timelineEvents: TimelineEvent[],
  lastTriagedAt: string | undefined,
  autoDiscover: boolean
): string {
  if (!lastTriagedAt) {
    return "There's no triage record for this item. Check the timeline for this bot's earlier labels or comments before treating anything as a first review.";
  }

  const latestUpdateMs = latestActivityMs(issue, timelineEvents);
  const triagedMs = parseTimestamp(lastTriagedAt);
  const hasNewActivity = triagedMs > 0 && latestUpdateMs > triagedMs;
  const selectionReason = hasNewActivity
    ? 'it has new activity since then and needs to be re-checked'
    : autoDiscover
      ? 'it is being revisited during another automated triage sweep'
      : 'the workflow explicitly asked for another review';

  return `This item was triaged before at ${lastTriagedAt}; it is being triaged again because ${selectionReason}. Review the current state and timeline, not as a first-time triage.`;
}
