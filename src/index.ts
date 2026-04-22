import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry, getDbEntry } from './storage';
import { AnalysisResult, buildSystemPrompt, buildUserPrompt, buildAnalysisResultSchema, getPromptLimits } from './analysis';
import { GitHubClient, Issue, TimelineEvent } from './github';
import { buildJsonPayload, GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';
import { buildAutoDiscoverQueue, filterPreviouslyTriagedClosedIssuesWithNewActivity } from './autoDiscover';
import { RunStatistics } from './stats';
import { AnalysisPassMode, chooseAnalysisPassMode } from './passSelection';
import chalk from 'chalk';

chalk.level = 3;

const cfg = getConfig();
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const gemini = new GeminiClient(cfg.geminiApiKey);
const stats = new RunStatistics();
stats.setRepository(cfg.owner, cfg.repo);
stats.setModelNames(cfg.modelFast, cfg.modelPro);

async function run(): Promise<void> {
  const repoLabels = await gh.listRepoLabels();
  const { targets, autoDiscover } = await listTargets();
  let proRunsPerformed = 0;
  let fastRunsPerformed = 0;
  let consecutiveFailures = 0;

  console.log(`⚙️ Running in ${cfg.dryRun ? 'dry-run' : 'live'} mode (strict: ${cfg.strictMode})`);
  console.log(`▶️ Discovered ${targets.length} item(s) from ${cfg.owner}/${cfg.repo} (extended: ${cfg.extended})`);
  console.log(`⏳ Fast runs limited to ${cfg.maxFastRuns} item(s), Pro runs limited to ${cfg.maxProRuns} item(s)`);

  const fastLimits = getPromptLimits(cfg, 'fast');
  const proLimits = getPromptLimits(cfg, 'pro');

  // Build static system prompts once for all issues
  const systemPromptFast = cfg.skipFastPass
    ? ''
    : buildSystemPrompt(cfg.promptPath, cfg.readmePath, repoLabels, cfg.additionalInstructions, 'fast', fastLimits);
  const systemPromptPro = buildSystemPrompt(
    cfg.promptPath,
    cfg.readmePath,
    repoLabels,
    cfg.additionalInstructions,
    'pro',
    proLimits
  );
  saveArtifact(0, 'prompt-system-fast.md', systemPromptFast);
  saveArtifact(0, 'prompt-system.md', systemPromptPro);

  // Create context caches for models that will be used (only when enabled)
  const cacheNames: Map<'fast' | 'pro', string> = new Map();
  if (cfg.contextCaching) {
    if (!cfg.skipFastPass) {
      try {
        const cacheName = await gemini.createCache(cfg.modelFast, systemPromptFast, `autotriage-fast-${cfg.owner}/${cfg.repo}`);
        cacheNames.set('fast', cacheName);
      } catch (err) {
        console.warn(`⚠️ Context caching unavailable for ${cfg.modelFast}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const cacheName = await gemini.createCache(cfg.modelPro, systemPromptPro, `autotriage-pro-${cfg.owner}/${cfg.repo}`);
      cacheNames.set('pro', cacheName);
    } catch (err) {
      console.warn(`⚠️ Context caching unavailable for ${cfg.modelPro}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    for (const n of targets) {
      const remainingProRuns = cfg.maxProRuns - proRunsPerformed;
      const remainingFastRuns = cfg.maxFastRuns - fastRunsPerformed;

      try {
        const issue = await gh.getIssue(n);
        const result = await processIssue(
          issue,
          repoLabels,
          autoDiscover,
          systemPromptFast,
          systemPromptPro,
          cacheNames,
          remainingFastRuns,
          remainingProRuns
        );

        if (!result.processed) {
          console.log(
            result.passMode === 'fast'
              ? `⏳ #${n} needs the fast model, but max fast runs (${cfg.maxFastRuns}) has been reached; skipping.`
              : `⏳ #${n} needs the pro model, but max pro runs (${cfg.maxProRuns}) has been reached; skipping.`
          );
          stats.incrementSkipped();
          continue;
        }

        stats.incrementTriaged();
        if (result.passMode === 'pro') {
          proRunsPerformed++;
        }
        if (result.passMode === 'fast') fastRunsPerformed++;
        consecutiveFailures = 0; // reset on success path
      } catch (err) {
        if (err instanceof GeminiResponseError) {
          console.warn(`#${n}: ${err.message}`);
          stats.incrementFailed();
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            console.error(`Analysis failed ${consecutiveFailures} consecutive times; stopping further processing.`);
            break;
          }
          continue;
        }
        // Re-throw non-Gemini errors to stop processing
        throw err;
      }

      saveDatabase(db, cfg.dbPath, cfg.dryRun);
    }
  } finally {
    // Clean up caches
    for (const [passMode, name] of cacheNames) {
      await gemini.deleteCache(name);
    }
  }

  // Print summary at the end
  stats.incrementGithubApiCalls(gh.getApiCallCount());
  stats.printSummary();
  if (cfg.strictMode && stats.getFailed() > 0) {
    core.setFailed(`Strict mode enabled: ${stats.getFailed()} run(s) had errors.`);
  }
}

run();

async function processIssue(
  issue: Issue,
  repoLabels: Array<{ name: string; description?: string | null }>,
  autoDiscover: boolean,
  systemPromptFast: string,
  systemPromptPro: string,
  cacheNames: Map<'fast' | 'pro', string>,
  remainingFastRuns: number,
  remainingProRuns: number
): Promise<{ processed: boolean; passMode: AnalysisPassMode }> {
  const dbEntry = getDbEntry(db, issue.number);
  const timelineFetchLimit = Math.max(cfg.maxFastTimelineEvents, cfg.maxProTimelineEvents);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(
    issue.number,
    timelineFetchLimit,
    issue.type === 'pull request'
  );
  const fastLimits = getPromptLimits(cfg, 'fast');
  const proLimits = getPromptLimits(cfg, 'pro');
  const fastTimelineEvents = timelineEvents.slice(-fastLimits.timelineEvents);
  const proTimelineEvents = timelineEvents.slice(-proLimits.timelineEvents);
  const latestUpdateMs = gh.lastUpdated(issue, rawTimelineEvents);
  const passMode = chooseAnalysisPassMode(dbEntry.lastTriaged, latestUpdateMs, !cfg.skipFastPass);
  const runContext = buildRunContext(issue, rawTimelineEvents, dbEntry.lastTriaged, autoDiscover);

  if (passMode === 'fast' && remainingFastRuns <= 0) {
    return { processed: false, passMode };
  }

  if (passMode === 'pro' && remainingProRuns <= 0) {
    return { processed: false, passMode };
  }

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));
    const model = passMode === 'fast' ? cfg.modelFast : cfg.modelPro;
    const limits = passMode === 'fast' ? fastLimits : proLimits;
    const timelineForPass = passMode === 'fast' ? fastTimelineEvents : proTimelineEvents;
    const systemPrompt = passMode === 'fast' ? systemPromptFast : systemPromptPro;
    const cacheName = cacheNames.get(passMode);
    const lastThoughts = passMode === 'pro' ? (dbEntry.thoughts || '') : '';
    const promptName = passMode === 'fast' ? 'prompt-fast-user.md' : 'prompt-user.md';

    console.log(
      passMode === 'fast'
        ? chalk.blue('Using fast model for an unchanged follow-up review.')
        : chalk.blue('Using pro model for a first-time or updated review.')
    );

    const userPrompt = buildUserPrompt(
      issue,
      timelineForPass,
      lastThoughts,
      passMode,
      limits,
      runContext
    );
    saveArtifact(issue.number, promptName, userPrompt);

    const { data: analysis, thoughts, ops } = await generateAnalysis(
      issue,
      model,
      cfg.thinkingBudget,
      systemPrompt,
      userPrompt,
      repoLabels,
      passMode === 'fast',
      cacheName,
      cfg.contextCaching
    );

    if (ops.length === 0) {
      console.log(chalk.yellow(`${passMode === 'fast' ? 'Fast' : 'Pro'} model suggested no operations.`));
    } else {
      saveArtifact(issue.number, 'operations.json', JSON.stringify(ops.map(o => o.toJSON()), null, 2));
      for (const op of ops) {
        await op.perform(gh, cfg, issue);
        // Track action details
        stats.trackAction({
          issueNumber: issue.number,
          type: op.kind,
          details: op.getActionDetails(),
        });
      }
    }

    updateDbEntry(db, issue.number, analysis.summary || issue.title, thoughts);
    return { processed: true, passMode };
  });
}

function buildRunContext(
  issue: Issue,
  timelineEvents: TimelineEvent[],
  lastTriagedAt: string | undefined,
  autoDiscover: boolean
): string {
  if (!lastTriagedAt) {
    return 'This item has no previous triage record, so treat this as the first review.';
  }

  const latestUpdateMs = gh.lastUpdated(issue, timelineEvents);
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
  issue: Issue,
  model: string,
  thinkingBudget: number,
  systemPrompt: string,
  userPrompt: string,
  repoLabels: Array<{ name: string; description?: string | null }>,
  isFastModel: boolean = false,
  cachedContentName?: string,
  useFlexTier: boolean = false
): Promise<{ data: AnalysisResult; thoughts: string, ops: TriageOperation[] }> {
  const schema = buildAnalysisResultSchema(repoLabels);
  const payload = buildJsonPayload(
    systemPrompt,
    userPrompt,
    schema,
    model,
    thinkingBudget,
    cachedContentName,
    useFlexTier
  );

  console.log(chalk.blue(`💭 Thinking with ${model}${cachedContentName ? ' (cached)' : ''}...`));
  const startTime = Date.now();
  const { data, thoughts, inputTokens, outputTokens } = await gemini.generateJson<AnalysisResult>(payload, 2, 5000);
  const endTime = Date.now();
  
  // Track model run stats
  const modelRunStats = { startTime, endTime, inputTokens, outputTokens };
  if (isFastModel) {
    stats.trackFastRun(modelRunStats);
  } else {
    stats.trackProRun(modelRunStats);
  }
  
  console.log(chalk.magenta(thoughts));
  saveArtifact(issue.number, `${model}-analysis.json`, JSON.stringify(data, null, 2));
  saveArtifact(issue.number, `${model}-thoughts.txt`, thoughts);

  const ops: TriageOperation[] = planOperations(issue, data, issue, repoLabels.map(l => l.name), thoughts);

  return { data, thoughts, ops };
}

async function listTargets(): Promise<{ targets: number[], autoDiscover: boolean }> {
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return { targets: fromInput, autoDiscover: false };

  // Event payload single target (issue or PR) takes priority over fallback listing.
  const payload: any = (await import('@actions/github')).context.payload;
  const num = payload?.issue?.number || payload?.pull_request?.number;
  if (num) return { targets: [Number(num)], autoDiscover: false };

  // Fallback: auto-discover mode prioritizes new/updated work first, then cycles through the rest.
  const issues = await gh.listOpenIssues();
  const recentlyClosedIssues = cfg.extended ? await gh.listRecentlyClosedIssues() : [];
  const closedIssuesToRecheck = filterPreviouslyTriagedClosedIssuesWithNewActivity(recentlyClosedIssues, db);
  const skipUnchanged = !cfg.extended;
  const orderedNumbers = buildAutoDiscoverQueue(issues.concat(closedIssuesToRecheck), db, skipUnchanged);
  return { targets: orderedNumbers, autoDiscover: true };
}
