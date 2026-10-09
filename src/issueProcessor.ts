import * as core from '@actions/core';
import chalk from 'chalk';
import { AnalysisResult, FastPassPlan, RepoLabel, parseAnalysisResult } from './analysis';
import { buildUserPrompt } from './prompts';
import { errorMessage, type ChatClient, type JsonRequest } from './llm/chat';
import { GitHubClient, Issue, TimelineEvent } from './github';
import { ItemRecord, RunStatistics, comparePlans, summarizePlan } from './stats';
import { PlannedOperation, describeOperation, executeOperations, explainPlan, planOperations } from './triage';
import type { Config, PromptPassMode } from './config';
import { TriageDb, getDbEntry, saveArtifact, updateDbEntry } from './storage';
import { parseTimestamp } from './util';

export type ModelClient = Pick<ChatClient, 'generateJson'>;
// When the fast pass is skipped, its entry is the pro client and is never called.
export type ModelClients = Record<PromptPassMode, ModelClient>;

export interface IssueProcessorDeps {
  cfg: Config;
  db: TriageDb;
  gh: GitHubClient;
  models: ModelClients;
  stats: RunStatistics;
}

export interface ProcessIssueOptions {
  issue: Issue;
  repoLabels: RepoLabel[];
  // The response schema, which the runner builds once from the repository's labels.
  schema: JsonRequest['schema'];
  autoDiscover: boolean;
  systemPromptFast: string;
  systemPromptPro: string;
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
  isFastModel?: boolean;
}

interface IssueContext {
  timelineEvents: Record<PromptPassMode, TimelineEvent[]>;
  runContext: string;
}

interface PassResult {
  analysis: AnalysisResult;
  operations: PlannedOperation[];
}

interface FastPassResult {
  plan?: PassResult;
  shouldSkipPro: boolean;
}

interface Deferral {
  // True when the item changed during analysis, rather than when it couldn't be rechecked.
  changed: boolean;
  detail: string;
}

// A pass that fails rethrows its error as a PassError, so the runner can record which pass failed.
export class PassError extends Error {
  constructor(readonly pass: PromptPassMode, readonly cause: unknown) {
    super(errorMessage(cause));
    this.name = 'PassError';
  }
}

async function inPass<T>(pass: PromptPassMode, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new PassError(pass, err);
  }
}

// Triages one item and returns its record for the run summary.
export async function processIssue(
  deps: IssueProcessorDeps,
  options: ProcessIssueOptions
): Promise<ItemRecord> {
  const { cfg, db, gh, models, stats } = deps;
  const { issue, repoLabels, schema, autoDiscover, systemPromptFast, systemPromptPro, runTimestamp, reanalysis = false } = options;

  return core.group(`🤖 #${issue.number} ${issue.title}${reanalysis ? ' (re-analysis)' : ''}`, async (): Promise<ItemRecord> => {
    const context = await loadIssueContext(
      { cfg, db, gh },
      { issue, autoDiscover }
    );
    const fastPass = await inPass('fast', () => runFastPass(
      { cfg, models, stats },
      { issue, repoLabels, schema, systemPromptFast, runTimestamp, context }
    ));
    const fastPlan = fastPass.plan && summarizePlan(fastPass.plan.operations);
    const item = { issueNumber: issue.number, type: issue.type, title: issue.title, ...(reanalysis ? { reanalyzed: true } : {}), fastPlan };

    if (fastPass.shouldSkipPro) {
      console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
      updateDbEntry(db, issue.number, fastPass.plan?.analysis.summary || issue.title, {
        lastSeenUpdatedAt: getConsumedUpdatedAt(issue),
      });
      return { ...item, outcome: 'skipped', escalatedToPro: false, agreement: fastPlan && 'fast-noop' };
    }

    const proPass = await inPass('pro', () => runPass(
      { cfg, models, stats },
      {
        mode: 'pro',
        issue,
        repoLabels,
        schema,
        systemPrompt: systemPromptPro,
        runTimestamp,
        context,
        ...(fastPass.plan ? { fastPassPlan: fastPass.plan } : {}),
      }
    ));

    // Applying the plan is part of the review pass, so a failed GitHub write is attributed to it.
    const deferral = await inPass('pro', () => executePlannedOperations(
      { cfg, gh, stats },
      { issue, operations: proPass.operations, reanalysis }
    ));

    const proPlan = summarizePlan(proPass.operations);
    const reviewed = { ...item, escalatedToPro: true, proPlan, agreement: fastPlan && comparePlans(fastPlan, proPlan) };
    if (deferral) {
      return { ...reviewed, outcome: 'deferred', detail: deferral.detail, ...(deferral.changed ? { changedDuringAnalysis: true } : {}) };
    }

    const consumedIssue = await resolveConsumedIssue(gh, cfg.dryRun, issue, proPass.operations);
    updateDbEntry(db, issue.number, proPass.analysis.summary || issue.title, {
      lastSeenUpdatedAt: getConsumedUpdatedAt(consumedIssue),
    });
    return { ...reviewed, outcome: 'triaged' };
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
  deps: Pick<IssueProcessorDeps, 'cfg' | 'db' | 'gh'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'autoDiscover'>
): Promise<IssueContext> {
  const { cfg, db, gh } = deps;
  const { issue, autoDiscover } = options;
  const dbEntry = getDbEntry(db, issue.number);
  const timelineFetchLimit = Math.max(cfg.limits.fast.timelineEvents, cfg.limits.pro.timelineEvents);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(
    issue.number,
    timelineFetchLimit,
    issue.type === 'pull request'
  );
  const runContext = buildRunContext(issue, rawTimelineEvents, dbEntry.lastTriaged, autoDiscover);

  saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

  return {
    timelineEvents: {
      fast: timelineEvents.slice(-cfg.limits.fast.timelineEvents),
      pro: timelineEvents.slice(-cfg.limits.pro.timelineEvents),
    },
    runContext,
  };
}

// The two passes differ only in which model, prompt, limits, and artifact name they use, so they share one body.
async function runPass(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'models' | 'stats'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'schema' | 'runTimestamp'> & {
    mode: PromptPassMode;
    systemPrompt: string;
    context: IssueContext;
    fastPassPlan?: FastPassPlan;
  }
): Promise<PassResult> {
  const { cfg, models, stats } = deps;
  const { mode, issue, repoLabels, schema, systemPrompt, runTimestamp, context, fastPassPlan } = options;
  const isFast = mode === 'fast';

  const userPrompt = buildUserPrompt(
    issue,
    context.timelineEvents[mode],
    mode,
    cfg.limits[mode],
    context.runContext,
    fastPassPlan,
    runTimestamp
  );
  saveArtifact(issue.number, isFast ? 'prompt-fast-user.md' : 'prompt-user.md', userPrompt);

  const { data: analysis, ops: operations } = await generateAnalysis(
    { model: models[mode], stats },
    {
      issue,
      model: isFast ? cfg.modelFast : cfg.modelPro,
      systemPrompt,
      userPrompt,
      repoLabels,
      schema,
      isFastModel: isFast,
    }
  );

  return { analysis, operations };
}

async function runFastPass(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'models' | 'stats'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'schema' | 'systemPromptFast' | 'runTimestamp'> & {
    context: IssueContext;
  }
): Promise<FastPassResult> {
  if (deps.cfg.skipFastPass) {
    console.log(chalk.blue('Fast pass skipped; using pro model directly.'));
    return { shouldSkipPro: false };
  }

  const plan = await runPass(deps, { ...options, mode: 'fast', systemPrompt: options.systemPromptFast });
  return { plan, shouldSkipPro: plan.operations.length === 0 };
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
    console.log(chalk.yellow('Pro model suggested no operations; skipping further processing.'));
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
  const { issue, model, systemPrompt, userPrompt, repoLabels, schema, isFastModel = false } = options;
  const request: JsonRequest = { model, systemPrompt, userPrompt, schema };

  console.log(chalk.blue(`💭 Thinking with ${model}...`));
  const startTime = Date.now();
  const { data, ...usage } = await deps.model.generateJson(request, parseAnalysisResult);
  const modelRunStats = { startTime, endTime: Date.now(), ...usage, issueNumber: issue.number };
  if (isFastModel) {
    stats.trackFastRun(modelRunStats);
  } else {
    stats.trackProRun(modelRunStats);
  }

  // The plan's summary and the policy clause each operation cites say why, in the log and the hidden comment block.
  const explanation = explainPlan(data);
  console.log(chalk.magenta(explanation));
  saveArtifact(issue.number, `${isFastModel ? 'fast' : 'pro'}-analysis.json`, JSON.stringify(data, null, 2));

  const ops = planOperations(issue, data, repoLabels.map((label) => label.name), explanation);
  return { data, ops };
}
