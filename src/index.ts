import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry, getDbEntry } from './storage';
import { AnalysisResult, buildSystemPrompt, buildUserPrompt, buildAnalysisResultSchema, getPromptLimits } from './analysis';
import { GitHubClient, Issue } from './github';
import { buildJsonPayload, GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';
import { buildAutoDiscoverQueue, filterPreviouslyTriagedClosedIssuesWithNewActivity } from './autoDiscover';
import { RunStatistics } from './stats';
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
  let triagesPerformed = 0;
  let fastRunsPerformed = 0;
  let consecutiveFailures = 0;

  console.log(`⚙️ Mode: ${cfg.dryRun ? 'dry-run' : 'live'}`);
  console.log(`▶️ Triaging up to ${cfg.maxProRuns} item(s) out of ${targets.length} from ${cfg.owner}/${cfg.repo} (${autoDiscover ? "auto-discover" : targets.map(t => `#${t}`).join(', ')})`);
  console.log(`⚡ Fast runs limited to ${cfg.maxFastRuns} item(s)`);

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
        console.log(`📦 Created context cache for ${cfg.modelFast}`);
      } catch (err) {
        console.warn(`⚠️ Context caching unavailable for ${cfg.modelFast}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const cacheName = await gemini.createCache(cfg.modelPro, systemPromptPro, `autotriage-pro-${cfg.owner}/${cfg.repo}`);
      cacheNames.set('pro', cacheName);
      console.log(`📦 Created context cache for ${cfg.modelPro}`);
    } catch (err) {
      console.warn(`⚠️ Context caching unavailable for ${cfg.modelPro}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    for (const n of targets) {
      const remainingTriages = cfg.maxProRuns - triagesPerformed;
      const remainingFastRuns = cfg.maxFastRuns - fastRunsPerformed;
      
      // Only check fast runs limit if we're not skipping the fast pass
      if (!cfg.skipFastPass && remainingFastRuns <= 0) {
          console.log(`⏳ Max fast runs (${cfg.maxFastRuns}) reached`);
          break;
        }
      
      if (remainingTriages <= 0) {
          console.log(`⏳ Max pro runs (${cfg.maxProRuns}) reached`);
          break;
        }

      try {
        const issue = await gh.getIssue(n);
        const { triageUsed, fastRunUsed } = await processIssue(issue, repoLabels, autoDiscover, systemPromptFast, systemPromptPro, cacheNames);
        if (triageUsed) {
          triagesPerformed++;
          stats.incrementTriaged();
        } else {
          stats.incrementSkipped();
        }
        if (fastRunUsed) fastRunsPerformed++;
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

      if (triagesPerformed >= cfg.maxProRuns) {
        console.log(`⏳ Max pro runs (${cfg.maxProRuns}) reached`);
        break;
      }

      saveDatabase(db, cfg.dbPath, cfg.dryRun);
    }
  } finally {
    // Clean up caches
    for (const [passMode, name] of cacheNames) {
      await gemini.deleteCache(name);
      console.log(`🗑️ Deleted context cache for ${passMode}`);
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
  cacheNames: Map<'fast' | 'pro', string>
): Promise<{ triageUsed: boolean; fastRunUsed: boolean }> {
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

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

    let fastRunUsed = false;

    // Pass 1: fast model (unless skip-fast-pass is enabled)
    if (!cfg.skipFastPass) {
      const fastUserPrompt = buildUserPrompt(
        issue,
        fastTimelineEvents,
        '',
        'fast',
        fastLimits
      );
      saveArtifact(issue.number, 'prompt-fast-user.md', fastUserPrompt);

      const { data: quickAnalysis, thoughts: quickThoughts, ops: quickOps } = await generateAnalysis(
        issue,
        cfg.modelFast,
        cfg.thinkingBudget,
        systemPromptFast,
        fastUserPrompt,
        repoLabels,
        true, // isFastModel
        cacheNames.get('fast')
      );
      
      fastRunUsed = true;

      // Fast pass produced no work: skip expensive pass.
      if (quickOps.length === 0) {
        console.log(chalk.yellow('Quick pass suggested no operations; skipping full analysis.'));
        updateDbEntry(db, issue.number, quickAnalysis.summary || issue.title, quickThoughts);
        return { triageUsed: false, fastRunUsed };
      }
    } else {
      console.log(chalk.blue('Fast pass skipped; using pro model directly.'));
    }

    // Pass 2: pro model (or only pass if skip-fast-pass is enabled)
    const proUserPrompt = buildUserPrompt(
      issue,
      proTimelineEvents,
      dbEntry.thoughts || '',
      'pro',
      proLimits
    );
    saveArtifact(issue.number, `prompt-user.md`, proUserPrompt);

    const { data: proAnalysis, thoughts: proThoughts, ops: proOps } = await generateAnalysis(
      issue,
      cfg.modelPro,
      cfg.thinkingBudget,
      systemPromptPro,
      proUserPrompt,
      repoLabels,
      false, // isFastModel
      cacheNames.get('pro')
    );

    if (proOps.length === 0) {
      console.log(chalk.yellow('Pro model suggested no operations; skipping further processing.'));
    } else {
      saveArtifact(issue.number, 'operations.json', JSON.stringify(proOps.map(o => o.toJSON()), null, 2));
      for (const op of proOps) {
        await op.perform(gh, cfg, issue);
        // Track action details
        stats.trackAction({
          issueNumber: issue.number,
          type: op.kind,
          details: op.getActionDetails(),
        });
      }
    }

    updateDbEntry(db, issue.number, proAnalysis.summary || issue.title, proThoughts);
    return { triageUsed: true, fastRunUsed };
  });
}

export async function generateAnalysis(
  issue: Issue,
  model: string,
  thinkingBudget: number,
  systemPrompt: string,
  userPrompt: string,
  repoLabels: Array<{ name: string; description?: string | null }>,
  isFastModel: boolean = false,
  cachedContentName?: string
): Promise<{ data: AnalysisResult; thoughts: string, ops: TriageOperation[] }> {
  const schema = buildAnalysisResultSchema(repoLabels);
  const payload = buildJsonPayload(
    systemPrompt,
    userPrompt,
    schema,
    model,
    thinkingBudget,
    cachedContentName
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
  const orderedNumbers = buildAutoDiscoverQueue(issues.concat(closedIssuesToRecheck), db, !cfg.extended);
  return { targets: orderedNumbers, autoDiscover: true };
}
