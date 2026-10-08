import * as core from '@actions/core';
import chalk from 'chalk';
import {
  AnalysisResult,
  FastPassPlan,
  PromptPassMode,
  RepoLabel,
  buildAnalysisResultSchema,
  buildUserPrompt,
  parseAnalysisResult,
} from './analysis';
import type { ChatClient, JsonRequest } from './llm/chat';
import { GitHubClient, Issue, TimelineEvent } from './github';
import { RunStatistics, comparePlans, summarizePlan } from './stats';
import { PlannedOperation, describeOperation, executeOperations, explainPlan, planOperations } from './triage';
import type { Config } from './config';
import { TriageDb, getDbEntry, saveArtifact, updateDbEntry } from './storage';
import { errorMessage, parseTimestamp } from './util';

type LastUpdatedFn = (issue: Issue, timelineEvents: TimelineEvent[]) => number;

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
  autoDiscover: boolean;
  systemPromptFast: string;
  systemPromptPro: string;
  runTimestamp: string;
}

export interface GenerateAnalysisOptions {
  issue: Issue;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoLabels: RepoLabel[];
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
  used: boolean;
  plan?: PassResult;
  shouldSkipPro: boolean;
}

export async function processIssue(
  deps: IssueProcessorDeps,
  options: ProcessIssueOptions
): Promise<{ triageUsed: boolean; fastRunUsed: boolean }> {
  const { cfg, db, gh, models, stats } = deps;
  const { issue, repoLabels, autoDiscover, systemPromptFast, systemPromptPro, runTimestamp } = options;

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    const context = await loadIssueContext(
      { cfg, db, gh },
      { issue, autoDiscover }
    );
    const fastPass = await runFastPass(
      { cfg, models, stats },
      { issue, repoLabels, systemPromptFast, runTimestamp, context }
    );
    const fastPlan = fastPass.used && fastPass.plan
      ? summarizePlan(fastPass.plan.operations)
      : undefined;

    if (fastPass.shouldSkipPro) {
      console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
      updateDbEntry(db, issue.number, fastPass.plan?.analysis.summary || issue.title, {
        lastSeenUpdatedAt: getConsumedUpdatedAt(issue),
      });
      stats.recordItem({
        issueNumber: issue.number,
        type: issue.type,
        outcome: 'skipped',
        skipReason: 'noop-fast',
        escalatedToPro: false,
        fastPlan,
        agreement: fastPlan && 'fast-noop',
      });
      return { triageUsed: false, fastRunUsed: fastPass.used };
    }

    const proPass = await runPass(
      { cfg, models, stats },
      {
        mode: 'pro',
        issue,
        repoLabels,
        systemPrompt: systemPromptPro,
        runTimestamp,
        context,
        ...(fastPass.plan ? { fastPassPlan: fastPass.plan } : {}),
      }
    );

    const executionResult = await executePlannedOperations(
      { cfg, gh, stats },
      { issue, operations: proPass.operations }
    );

    const proPlan = summarizePlan(proPass.operations);
    if (executionResult === 'deferred') {
      stats.recordItem({
        issueNumber: issue.number,
        type: issue.type,
        outcome: 'skipped',
        skipReason: 'deferred',
        escalatedToPro: fastPass.used,
        fastPlan,
        proPlan,
        agreement: fastPlan && comparePlans(fastPlan, proPlan),
      });
      return { triageUsed: true, fastRunUsed: fastPass.used };
    }

    const consumedIssue = await resolveConsumedIssue(gh, cfg.dryRun, issue, proPass.operations);
    updateDbEntry(db, issue.number, proPass.analysis.summary || issue.title, {
      lastSeenUpdatedAt: getConsumedUpdatedAt(consumedIssue),
    });
    stats.recordItem({
      issueNumber: issue.number,
      type: issue.type,
      outcome: 'triaged',
      escalatedToPro: fastPass.used,
      fastPlan,
      proPlan,
      agreement: fastPlan && comparePlans(fastPlan, proPlan),
    });
    return { triageUsed: true, fastRunUsed: fastPass.used };
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
  const runContext = buildRunContext(
    issue,
    rawTimelineEvents,
    dbEntry.lastTriaged,
    autoDiscover,
    (trackedIssue, events) => gh.lastUpdated(trackedIssue, events)
  );

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
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'runTimestamp'> & {
    mode: PromptPassMode;
    systemPrompt: string;
    context: IssueContext;
    fastPassPlan?: FastPassPlan;
  }
): Promise<PassResult> {
  const { cfg, models, stats } = deps;
  const { mode, issue, repoLabels, systemPrompt, runTimestamp, context, fastPassPlan } = options;
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
      isFastModel: isFast,
    }
  );

  return { analysis, operations };
}

async function runFastPass(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'models' | 'stats'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'systemPromptFast' | 'runTimestamp'> & {
    context: IssueContext;
  }
): Promise<FastPassResult> {
  if (deps.cfg.skipFastPass) {
    console.log(chalk.blue('Fast pass skipped; using pro model directly.'));
    return { used: false, shouldSkipPro: false };
  }

  const plan = await runPass(deps, { ...options, mode: 'fast', systemPrompt: options.systemPromptFast });
  return { used: true, plan, shouldSkipPro: plan.operations.length === 0 };
}

async function executePlannedOperations(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'gh' | 'stats'>,
  options: {
    issue: Issue;
    operations: PlannedOperation[];
  }
): Promise<'executed' | 'deferred'> {
  const { cfg, gh, stats } = deps;
  const { issue, operations } = options;

  if (operations.length === 0) {
    console.log(chalk.yellow('Pro model suggested no operations; skipping further processing.'));
    return 'executed';
  }

  saveArtifact(issue.number, 'operations.json', JSON.stringify(operations, null, 2));
  if (!cfg.dryRun) {
    try {
      const currentIssue = await gh.getIssue(issue.number);
      if (getConsumedUpdatedAt(currentIssue) !== getConsumedUpdatedAt(issue)) {
        console.warn(
          `⚠️ #${issue.number} changed while it was being analyzed; deferring planned operations for re-triage.`
        );
        return 'deferred';
      }
    } catch (err) {
      console.warn(
        `⚠️ Failed to recheck #${issue.number} before applying operations: ${errorMessage(err)}. ` +
        'Deferring planned operations for re-triage.'
      );
      return 'deferred';
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
  return 'executed';
}

export function buildRunContext(
  issue: Issue,
  timelineEvents: TimelineEvent[],
  lastTriagedAt: string | undefined,
  autoDiscover: boolean,
  getLastUpdated: LastUpdatedFn
): string {
  if (!lastTriagedAt) {
    return 'This item has no previous triage record, so treat this as the first review.';
  }

  const latestUpdateMs = getLastUpdated(issue, timelineEvents);
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
  const { issue, model, systemPrompt, userPrompt, repoLabels, isFastModel = false } = options;
  const request: JsonRequest = { model, systemPrompt, userPrompt, schema: buildAnalysisResultSchema(repoLabels) };

  console.log(chalk.blue(`💭 Thinking with ${model}...`));
  stats.beginPass(isFastModel ? 'fast' : 'pro');
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

  const ops = planOperations(issue, data, issue, repoLabels.map((label) => label.name), explanation);
  return { data, ops };
}
