import * as core from '@actions/core';
import chalk from 'chalk';
import { AnalysisResult, RepoLabel, parseAnalysisResult } from './analysis';
import { TIMELINE_EVENTS, buildUserPrompt } from './prompts';
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

export interface GenerateAnalysisOptions {
  issue: Issue;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoLabels: RepoLabel[];
  schema: JsonRequest['schema'];
}

interface IssueContext {
  timelineEvents: TimelineEvent[];
  runContext: string;
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
    const context = await loadIssueContext(
      { db, gh },
      { issue, autoDiscover }
    );
    const operations = await analyze(
      { cfg, model, stats },
      { issue, repoLabels, schema, systemPrompt, runTimestamp, context }
    );
    const deferral = await executePlannedOperations(
      { cfg, gh, stats },
      { issue, operations, reanalysis }
    );

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
  gh: Pick<IssueProcessorDeps, 'gh'>['gh'],
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

async function loadIssueContext(
  deps: Pick<IssueProcessorDeps, 'db' | 'gh'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'autoDiscover'>
): Promise<IssueContext> {
  const { db, gh } = deps;
  const { issue, autoDiscover } = options;
  const dbEntry = getDbEntry(db, issue.number);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(
    issue.number,
    TIMELINE_EVENTS,
    issue.type === 'pull request'
  );
  const runContext = buildRunContext(issue, rawTimelineEvents, dbEntry.lastTriaged, autoDiscover);

  saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

  return {
    timelineEvents: timelineEvents.slice(-TIMELINE_EVENTS),
    runContext,
  };
}

async function analyze(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'model' | 'stats'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'schema' | 'systemPrompt' | 'runTimestamp'> & {
    context: IssueContext;
  }
): Promise<PlannedOperation[]> {
  const { cfg, model, stats } = deps;
  const { issue, repoLabels, schema, systemPrompt, runTimestamp, context } = options;

  const userPrompt = buildUserPrompt(
    issue,
    context.timelineEvents,
    context.runContext,
    runTimestamp
  );
  saveArtifact(issue.number, 'prompt-user.md', userPrompt);

  const { ops: operations } = await generateAnalysis(
    { model, stats },
    {
      issue,
      model: cfg.model.model,
      systemPrompt,
      userPrompt,
      repoLabels,
      schema,
    }
  );

  return operations;
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

  if (operations.length === 0) {
    console.log(chalk.yellow('The model planned no operations.'));
    return undefined;
  }

  saveArtifact(issue.number, 'operations.json', JSON.stringify(operations, null, 2));
  if (!cfg.dryRun) {
    // The deferred plan is logged, because a re-analysis replaces the item's artifacts.
    const deferring = `Deferring its planned operations: ${operations.map(describeOperation).join(', ')}.`;
    try {
      const currentIssue = await gh.getIssue(issue.number);
      const analyzedUpdatedAt = getConsumedUpdatedAt(issue);
      const currentUpdatedAt = getConsumedUpdatedAt(currentIssue);
      if (currentUpdatedAt !== analyzedUpdatedAt) {
        console.warn(
          `⚠️ #${issue.number} changed while it was being analyzed (updated at ${analyzedUpdatedAt}, now ${currentUpdatedAt}). ${deferring}`
        );
        return {
          changed: true,
          detail: reanalysis
            ? 'It changed again while it was being re-analyzed, so the plan wasn\'t applied.'
            : 'It changed while it was being analyzed, so the plan wasn\'t applied.',
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
    return 'This item has no previous triage record, so treat this as the first review.';
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

export async function generateAnalysis(
  deps: { model: ModelClient; stats: RunStatistics },
  options: GenerateAnalysisOptions
): Promise<{ data: AnalysisResult; ops: PlannedOperation[] }> {
  const { stats } = deps;
  const { issue, model, systemPrompt, userPrompt, repoLabels, schema } = options;
  const request: JsonRequest = { model, systemPrompt, userPrompt, schema };

  // It says "asking" rather than "thinking", because some providers report no reasoning.
  console.log(chalk.blue(`💭 Asking ${model}...`));
  const startTime = Date.now();
  const { data, ...usage } = await deps.model.generateJson(request, parseAnalysisResult);
  const modelRunStats = { startTime, endTime: Date.now(), ...usage, issueNumber: issue.number };
  console.log(chalk.blue(describeModelRun(modelRunStats)));
  stats.trackModelRun(modelRunStats);

  // The plan's summary and the policy clause each operation cites say why, in the log and the hidden comment block.
  const explanation = explainPlan(data);
  console.log(chalk.magenta(explanation));
  saveArtifact(issue.number, 'analysis.json', JSON.stringify(data, null, 2));

  const ops = planOperations(issue, data, repoLabels.map((label) => label.name), explanation);
  return { data, ops };
}
