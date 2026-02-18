import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry, getDbEntry } from './storage';
import { AnalysisResult, buildSystemPrompt, buildUserPrompt, buildAnalysisResultSchema } from './analysis';
import { GitHubClient, Issue } from './github';
import { buildJsonPayload, GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';
import { buildAutoDiscoverQueue } from './autoDiscover';
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

  console.log(`⚙️ Enabled: ${cfg.enabled ? 'yes' : 'dry-run'}`);
  console.log(`▶️ Triaging up to ${cfg.maxTriages} item(s) out of ${targets.length} from ${cfg.owner}/${cfg.repo} (${autoDiscover ? "auto-discover" : targets.map(t => `#${t}`).join(', ')})`);
  console.log(`⚡ Fast runs limited to ${cfg.maxFastRuns} item(s)`);

  // Build the static system prompt once for all issues
  const systemPrompt = buildSystemPrompt(
    cfg.promptPath,
    cfg.readmePath,
    repoLabels,
    cfg.additionalInstructions
  );
  saveArtifact(0, 'prompt-system.md', systemPrompt);

  // Create context caches for models that will be used (only when enabled)
  const cacheNames: Map<string, string> = new Map();
  if (cfg.contextCaching) {
    const modelsToCache = new Set<string>();
    if (!cfg.skipFastPass) modelsToCache.add(cfg.modelFast);
    modelsToCache.add(cfg.modelPro);

    for (const model of modelsToCache) {
      try {
        const cacheName = await gemini.createCache(model, systemPrompt, `autotriage-${cfg.owner}/${cfg.repo}`);
        cacheNames.set(model, cacheName);
        console.log(`📦 Created context cache for ${model}`);
      } catch (err) {
        console.warn(`⚠️ Context caching unavailable for ${model}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  try {
    for (const n of targets) {
      const remainingTriages = cfg.maxTriages - triagesPerformed;
      const remainingFastRuns = cfg.maxFastRuns - fastRunsPerformed;
      
      // Only check fast runs limit if we're not skipping the fast pass
      if (!cfg.skipFastPass && remainingFastRuns <= 0) {
        console.log(`⏳ Max fast runs (${cfg.maxFastRuns}) reached`);
        break;
      }
      
      if (remainingTriages <= 0) {
        console.log(`⏳ Max triages (${cfg.maxTriages}) reached`);
        break;
      }

      try {
        const issue = await gh.getIssue(n);
        const { triageUsed, fastRunUsed } = await processIssue(issue, repoLabels, autoDiscover, systemPrompt, cacheNames);
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

      if (triagesPerformed >= cfg.maxTriages) {
        console.log(`⏳ Max triages (${cfg.maxTriages}) reached`);
        break;
      }

      saveDatabase(db, cfg.dbPath, cfg.enabled);
    }
  } finally {
    // Clean up caches
    for (const [model, name] of cacheNames) {
      await gemini.deleteCache(name);
      console.log(`🗑️ Deleted context cache for ${model}`);
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
  systemPrompt: string,
  cacheNames: Map<string, string>
): Promise<{ triageUsed: boolean; fastRunUsed: boolean }> {
  const dbEntry = getDbEntry(db, issue.number);
  const { raw: rawTimelineEvents, filtered: timelineEvents } = await gh.listTimelineEvents(issue.number, cfg.maxTimelineEvents);

  return core.group(`🤖 #${issue.number} ${issue.title}`, async () => {
    saveArtifact(issue.number, 'timeline.json', JSON.stringify(rawTimelineEvents, null, 2));

    const userPrompt = buildUserPrompt(
      issue,
      timelineEvents,
      dbEntry.thoughts || ''
    );

    saveArtifact(issue.number, `prompt-user.md`, userPrompt);

    let fastRunUsed = false;

    // Pass 1: fast model (unless skip-fast-pass is enabled)
    if (!cfg.skipFastPass) {
      const { data: quickAnalysis, thoughts: quickThoughts, ops: quickOps } = await generateAnalysis(
        issue,
        cfg.modelFast,
        cfg.modelFastTemperature,
        cfg.thinkingBudget,
        systemPrompt,
        userPrompt,
        repoLabels,
        true, // isFastModel
        cacheNames.get(cfg.modelFast)
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
    const { data: proAnalysis, thoughts: proThoughts, ops: proOps } = await generateAnalysis(
      issue,
      cfg.modelPro,
      cfg.modelProTemperature,
      cfg.thinkingBudget,
      systemPrompt,
      userPrompt,
      repoLabels,
      false, // isFastModel
      cacheNames.get(cfg.modelPro)
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
  modelTemperature: number,
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
    modelTemperature,
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
  const orderedNumbers = buildAutoDiscoverQueue(issues, db, cfg.skipUnchanged);
  return { targets: orderedNumbers, autoDiscover: true };
}
