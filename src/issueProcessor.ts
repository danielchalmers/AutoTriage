import * as core from '@actions/core';
import chalk from 'chalk';
import {
  AnalysisResult,
  FastPassPlan,
  buildAnalysisResultSchema,
  buildUserPrompt,
  getUserPromptBudgetContentStats,
  getPromptLimits,
  PromptBudgetContentStats,
  sumPromptBudgetContentStats,
} from './analysis';
import { GeminiCacheInfo, GeminiClient, buildJsonPayload } from './gemini';
import { GitHubClient, Issue, TimelineEvent } from './github';
import { getRunStatistics } from './stats';
import { TriageOperation, planOperations } from './triage';
import type { Config } from './config';
import { TriageDb, getDbEntry, saveArtifact, updateDbEntry } from './storage';

type RepoLabel = { name: string; description?: string | null };
type LastUpdatedFn = (issue: Issue, timelineEvents: TimelineEvent[]) => number;

export interface IssueProcessorDeps {
  cfg: Config;
  db: TriageDb;
  gh: GitHubClient;
  gemini: GeminiClient;
}

export interface ProcessIssueOptions {
  issue: Issue;
  repoLabels: RepoLabel[];
  autoDiscover: boolean;
  systemPromptFast: string;
  systemPromptPro: string;
  fastSystemPromptBudgetContent: PromptBudgetContentStats;
  proSystemPromptBudgetContent: PromptBudgetContentStats;
  cacheInfos: Map<'fast' | 'pro', GeminiCacheInfo>;
  runTimestamp: string;
}

export interface GenerateAnalysisOptions {
  issue: Issue;
  model: string;
  thinkingBudget: number;
  systemPrompt: string;
  userPrompt: string;
  repoLabels: RepoLabel[];
  isFastModel?: boolean;
  cacheInfo?: GeminiCacheInfo | undefined;
  useFlexTier?: boolean;
  budgetContentStats?: PromptBudgetContentStats;
}

export async function processIssue(
  deps: IssueProcessorDeps,
  options: ProcessIssueOptions
): Promise<{ triageUsed: boolean; fastRunUsed: boolean }> {
  const { cfg, db, gh, gemini } = deps;
  const stats = getRunStatistics();
  const {
    issue,
    repoLabels,
    autoDiscover,
    systemPromptFast,
    systemPromptPro,
    fastSystemPromptBudgetContent,
    proSystemPromptBudgetContent,
    cacheInfos,
    runTimestamp,
  } = options;
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

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

    let fastRunUsed = false;
    let fastPassPlan: FastPassPlan | undefined;

    if (!cfg.skipFastPass) {
      const fastUserPrompt = buildUserPrompt(
        issue,
        timelineEvents,
        'fast',
        fastLimits,
        runContext,
        undefined,
        runTimestamp
      );
      saveArtifact(issue.number, 'prompt-fast-user.md', fastUserPrompt);

      const { data: quickAnalysis, ops: quickOps } = await generateAnalysis(
        { gemini },
        {
          issue,
          model: cfg.modelFast,
          thinkingBudget: cfg.thinkingBudget,
          systemPrompt: systemPromptFast,
          userPrompt: fastUserPrompt,
          repoLabels,
          isFastModel: true,
          cacheInfo: cacheInfos.get('fast'),
          useFlexTier: cfg.contextCaching,
          budgetContentStats: sumPromptBudgetContentStats(
            fastSystemPromptBudgetContent,
            getUserPromptBudgetContentStats(issue, timelineEvents, fastLimits)
          ),
        }
      );

      fastRunUsed = true;
      fastPassPlan = {
        analysis: quickAnalysis,
        operations: quickOps.map((op) => op.toJSON()),
      };

      if (quickOps.length === 0) {
        console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
        updateDbEntry(db, issue.number, quickAnalysis.summary || issue.title);
        return { triageUsed: false, fastRunUsed };
      }
    } else {
      console.log(chalk.blue('Fast pass skipped; using pro model directly.'));
    }

    const proUserPrompt = buildUserPrompt(
      issue,
      timelineEvents,
      'pro',
      proLimits,
      runContext,
      fastPassPlan,
      runTimestamp
    );
    saveArtifact(issue.number, 'prompt-user.md', proUserPrompt);

    const { data: proAnalysis, ops: proOps } = await generateAnalysis(
      { gemini },
      {
        issue,
        model: cfg.modelPro,
        thinkingBudget: cfg.thinkingBudget,
        systemPrompt: systemPromptPro,
        userPrompt: proUserPrompt,
        repoLabels,
        cacheInfo: cacheInfos.get('pro'),
        useFlexTier: cfg.contextCaching,
        budgetContentStats: sumPromptBudgetContentStats(
          proSystemPromptBudgetContent,
          getUserPromptBudgetContentStats(issue, timelineEvents, proLimits)
        ),
      }
    );

    if (proOps.length === 0) {
      console.log(chalk.yellow('Pro model suggested no operations; skipping further processing.'));
    } else {
      saveArtifact(issue.number, 'operations.json', JSON.stringify(proOps.map((op) => op.toJSON()), null, 2));
      for (const op of proOps) {
        await op.perform(gh, cfg, issue);
        stats.trackAction({
          issueNumber: issue.number,
          type: op.kind,
          details: op.getActionDetails(),
        });
      }
    }

    updateDbEntry(db, issue.number, proAnalysis.summary || issue.title);
    return { triageUsed: true, fastRunUsed };
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
  deps: Pick<IssueProcessorDeps, 'gemini'>,
  options: GenerateAnalysisOptions
): Promise<{ data: AnalysisResult; thoughts: string; ops: TriageOperation[] }> {
  const { gemini } = deps;
  const stats = getRunStatistics();
  const {
    issue,
    model,
    thinkingBudget,
    systemPrompt,
    userPrompt,
    repoLabels,
    isFastModel = false,
    cacheInfo,
    useFlexTier = false,
    budgetContentStats,
  } = options;
  const schema = buildAnalysisResultSchema(repoLabels);
  const artifactPrefix = isFastModel ? 'fast' : 'pro';
  const payload = buildJsonPayload(
    systemPrompt,
    userPrompt,
    schema,
    model,
    thinkingBudget,
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
  if (budgetContentStats) {
    stats.trackBudgetContent(isFastModel ? 'fast' : 'pro', budgetContentStats);
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
