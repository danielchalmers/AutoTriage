import * as core from '@actions/core';
import chalk from 'chalk';
import {
  AnalysisResult,
  FastPassPlan,
  buildAnalysisResultSchema,
  buildUserPrompt,
  getPromptLimits,
} from './analysis';
import { GeminiCacheInfo, GeminiClient, buildJsonPayload } from './gemini';
import { GitHubClient, Issue, TimelineEvent } from './github';
import { RunStatistics } from './stats';
import { PlannedOperation, describeOperation, executeOperations, planOperations } from './triage';
import type { Config } from './config';
import { TriageDb, getDbEntry, saveArtifact, updateDbEntry } from './storage';

type RepoLabel = { name: string; description?: string | null };
type LastUpdatedFn = (issue: Issue, timelineEvents: TimelineEvent[]) => number;

export interface IssueProcessorDeps {
  cfg: Config;
  db: TriageDb;
  gh: GitHubClient;
  gemini: GeminiClient;
  stats: RunStatistics;
}

export interface ProcessIssueOptions {
  issue: Issue;
  repoLabels: RepoLabel[];
  autoDiscover: boolean;
  systemPromptFast: string;
  systemPromptPro: string;
  cacheInfos: Map<'fast' | 'pro', GeminiCacheInfo>;
  runTimestamp: string;
}

export interface GenerateAnalysisOptions {
  issue: Issue;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoLabels: RepoLabel[];
  isFastModel?: boolean;
  cacheInfo?: GeminiCacheInfo | undefined;
  useFlexTier?: boolean;
}

type PromptLimits = ReturnType<typeof getPromptLimits>;

interface IssueContext {
  fastTimelineEvents: TimelineEvent[];
  proTimelineEvents: TimelineEvent[];
  fastLimits: PromptLimits;
  proLimits: PromptLimits;
  runContext: string;
}

interface FastPassResult {
  used: boolean;
  plan?: FastPassPlan;
  shouldSkipPro: boolean;
}

interface ProPassResult {
  analysis: AnalysisResult;
  operations: PlannedOperation[];
}

export async function processIssue(
  deps: IssueProcessorDeps,
  options: ProcessIssueOptions
): Promise<{ triageUsed: boolean; fastRunUsed: boolean }> {
  const { cfg, db, gh, gemini, stats } = deps;
  const { issue, repoLabels, autoDiscover, systemPromptFast, systemPromptPro, cacheInfos, runTimestamp } = options;

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    const context = await loadIssueContext(
      { cfg, db, gh },
      { issue, autoDiscover }
    );
    const fastPass = await runFastPass(
      { cfg, gemini, stats },
      { issue, repoLabels, systemPromptFast, cacheInfos, runTimestamp, context }
    );

    if (fastPass.shouldSkipPro) {
      console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
      updateDbEntry(db, issue.number, fastPass.plan?.analysis.summary || issue.title, {
        lastSeenUpdatedAt: getConsumedUpdatedAt(issue),
      });
      return { triageUsed: false, fastRunUsed: fastPass.used };
    }

    const proPass = await runProPass(
      { cfg, gemini, stats },
      {
        issue,
        repoLabels,
        systemPromptPro,
        cacheInfos,
        runTimestamp,
        context,
        ...(fastPass.plan ? { fastPassPlan: fastPass.plan } : {}),
      }
    );

    await executePlannedOperations(
      { cfg, gh, stats },
      { issue, operations: proPass.operations }
    );

    const consumedIssue = await resolveConsumedIssue(gh, cfg.dryRun, issue, proPass.operations);
    updateDbEntry(db, issue.number, proPass.analysis.summary || issue.title, {
      lastSeenUpdatedAt: getConsumedUpdatedAt(consumedIssue),
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

  return gh.getIssue(issue.number);
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
  const timelineFetchLimit = Math.max(cfg.maxFastTimelineEvents, cfg.maxProTimelineEvents);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(
    issue.number,
    timelineFetchLimit,
    issue.type === 'pull request'
  );
  const fastLimits = getPromptLimits(cfg, 'fast');
  const proLimits = getPromptLimits(cfg, 'pro');
  const runContext = buildRunContext(
    issue,
    rawTimelineEvents,
    dbEntry.lastTriaged,
    autoDiscover,
    (trackedIssue, events) => gh.lastUpdated(trackedIssue, events)
  );

  saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

  return {
    fastTimelineEvents: timelineEvents.slice(-fastLimits.timelineEvents),
    proTimelineEvents: timelineEvents.slice(-proLimits.timelineEvents),
    fastLimits,
    proLimits,
    runContext,
  };
}

async function runFastPass(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'gemini' | 'stats'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'systemPromptFast' | 'cacheInfos' | 'runTimestamp'> & {
    context: IssueContext;
  }
): Promise<FastPassResult> {
  const { cfg, gemini, stats } = deps;
  const { issue, repoLabels, systemPromptFast, cacheInfos, runTimestamp, context } = options;

  if (cfg.skipFastPass) {
    console.log(chalk.blue('Fast pass skipped; using pro model directly.'));
    return { used: false, shouldSkipPro: false };
  }

  const fastUserPrompt = buildUserPrompt(
    issue,
    context.fastTimelineEvents,
    'fast',
    context.fastLimits,
    context.runContext,
    undefined,
    runTimestamp
  );
  saveArtifact(issue.number, 'prompt-fast-user.md', fastUserPrompt);

  const { data: analysis, ops: operations } = await generateAnalysis(
    { gemini, stats },
    {
      issue,
      model: cfg.modelFast,
      systemPrompt: systemPromptFast,
      userPrompt: fastUserPrompt,
      repoLabels,
      isFastModel: true,
      cacheInfo: cacheInfos.get('fast'),
      useFlexTier: cacheInfos.has('fast'),
    }
  );

  return {
    used: true,
    plan: {
      analysis,
      operations,
    },
    shouldSkipPro: operations.length === 0,
  };
}

async function runProPass(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'gemini' | 'stats'>,
  options: Pick<ProcessIssueOptions, 'issue' | 'repoLabels' | 'systemPromptPro' | 'cacheInfos' | 'runTimestamp'> & {
    context: IssueContext;
    fastPassPlan?: FastPassPlan;
  }
): Promise<ProPassResult> {
  const { cfg, gemini, stats } = deps;
  const { issue, repoLabels, systemPromptPro, cacheInfos, runTimestamp, context, fastPassPlan } = options;

  const proUserPrompt = buildUserPrompt(
    issue,
    context.proTimelineEvents,
    'pro',
    context.proLimits,
    context.runContext,
    fastPassPlan,
    runTimestamp
  );
  saveArtifact(issue.number, 'prompt-user.md', proUserPrompt);

  const { data: analysis, ops: operations } = await generateAnalysis(
    { gemini, stats },
    {
      issue,
      model: cfg.modelPro,
      systemPrompt: systemPromptPro,
      userPrompt: proUserPrompt,
      repoLabels,
      cacheInfo: cacheInfos.get('pro'),
      useFlexTier: cacheInfos.has('pro'),
    }
  );

  return { analysis, operations };
}

async function executePlannedOperations(
  deps: Pick<IssueProcessorDeps, 'cfg' | 'gh' | 'stats'>,
  options: {
    issue: Issue;
    operations: PlannedOperation[];
  }
): Promise<void> {
  const { cfg, gh, stats } = deps;
  const { issue, operations } = options;

  if (operations.length === 0) {
    console.log(chalk.yellow('Pro model suggested no operations; skipping further processing.'));
    return;
  }

  saveArtifact(issue.number, 'operations.json', JSON.stringify(operations, null, 2));
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
  const triagedMs = Date.parse(lastTriagedAt);
  const hasNewActivity = Number.isFinite(triagedMs) && latestUpdateMs > triagedMs;
  const selectionReason = hasNewActivity
    ? 'it has new activity since then and needs to be re-checked'
    : autoDiscover
      ? 'it is being revisited during another automated triage sweep'
      : 'the workflow explicitly asked for another review';

  return `This item was triaged before at ${lastTriagedAt}; it is being triaged again because ${selectionReason}. Review the current state and timeline, not as a first-time triage.`;
}

export async function generateAnalysis(
  deps: Pick<IssueProcessorDeps, 'gemini' | 'stats'>,
  options: GenerateAnalysisOptions
): Promise<{ data: AnalysisResult; thoughts: string; ops: PlannedOperation[] }> {
  const { gemini, stats } = deps;
  const {
    issue,
    model,
    systemPrompt,
    userPrompt,
    repoLabels,
    isFastModel = false,
    cacheInfo,
    useFlexTier = false,
  } = options;
  const schema = buildAnalysisResultSchema(repoLabels);
  const artifactPrefix = isFastModel ? 'fast' : 'pro';
  const payload = buildJsonPayload(
    systemPrompt,
    userPrompt,
    schema,
    model,
    cacheInfo?.name,
    useFlexTier
  );

  console.log(chalk.blue(`💭 Thinking with ${model}${cacheInfo ? ' (cached)' : ''}...`));
  const startTime = Date.now();
  const { data, thoughts, inputTokens, cachedInputTokens, outputTokens } = await gemini.generateJson<AnalysisResult>(payload, 2, 7500);
  const endTime = Date.now();

  const modelRunStats = {
    startTime,
    endTime,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(cacheInfo ? { cacheName: cacheInfo.name } : {}),
  };
  if (isFastModel) {
    stats.trackFastRun(modelRunStats);
  } else {
    stats.trackProRun(modelRunStats);
  }

  console.log(chalk.magenta(thoughts));
  saveArtifact(
    issue.number,
    `${artifactPrefix}-analysis.json`,
    JSON.stringify({ ...data, thoughts }, null, 2)
  );

  const ops = planOperations(issue, data, issue, repoLabels.map((label) => label.name), thoughts);

  return { data, thoughts, ops };
}
