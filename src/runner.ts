import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  buildSystemPrompt,
  getPromptLimits,
  normalizeRepoLabels,
} from './analysis';
import {
  buildAutoDiscoverQueue,
  filterPreviouslyTriagedClosedIssuesWithNewActivity,
} from './autoDiscover';
import { GeminiCacheInfo, GeminiClient, GeminiResponseError } from './gemini';
import { GitHubClient } from './github';
import { IssueProcessorDeps, processIssue } from './issueProcessor';
import { RunStatistics } from './stats';
import { Config, TriageDb, saveArtifact, saveDatabase } from './storage';

export interface AutoTriageDeps extends IssueProcessorDeps {
  cfg: Config;
  db: TriageDb;
  gh: GitHubClient;
  gemini: GeminiClient;
  stats: RunStatistics;
}

export interface ListTargetsDeps {
  cfg: Config;
  db: TriageDb;
  gh: Pick<GitHubClient, 'listOpenIssues' | 'listRecentlyClosedIssues'>;
  payload?: any;
}

export async function runAutoTriage(deps: AutoTriageDeps): Promise<void> {
  const { cfg, db, gh, gemini, stats } = deps;
  const repoLabels = normalizeRepoLabels(await gh.listRepoLabels());
  const { targets, autoDiscover } = await listTargets({ cfg, db, gh });
  const runTimestamp = new Date().toISOString();
  let triagesPerformed = 0;
  let fastRunsPerformed = 0;
  let consecutiveFailures = 0;

  console.log(`⚙️ Running in ${cfg.dryRun ? 'dry-run' : 'live'} mode (strict: ${cfg.strictMode})`);
  console.log(`▶️ Discovered ${targets.length} item(s) from ${cfg.owner}/${cfg.repo} (extended: ${cfg.extended})`);
  console.log(`⏳ Fast runs limited to ${cfg.maxFastRuns} item(s), Pro runs limited to ${cfg.maxProRuns} item(s)`);

  const fastLimits = getPromptLimits(cfg, 'fast');
  const proLimits = getPromptLimits(cfg, 'pro');
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

  const cacheInfos: Map<'fast' | 'pro', GeminiCacheInfo> = new Map();
  if (cfg.contextCaching) {
    if (!cfg.skipFastPass) {
      try {
        const cacheInfo = await gemini.createCache(cfg.modelFast, systemPromptFast, `autotriage-fast-${cfg.owner}/${cfg.repo}`);
        cacheInfos.set('fast', cacheInfo);
        stats.trackCacheCreate({
          mode: 'fast',
          model: cfg.modelFast,
          name: cacheInfo.name,
          tokenCount: cacheInfo.tokenCount,
        });
      } catch (err) {
        console.warn(`⚠️ Context caching unavailable for ${cfg.modelFast}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const cacheInfo = await gemini.createCache(cfg.modelPro, systemPromptPro, `autotriage-pro-${cfg.owner}/${cfg.repo}`);
      cacheInfos.set('pro', cacheInfo);
      stats.trackCacheCreate({
        mode: 'pro',
        model: cfg.modelPro,
        name: cacheInfo.name,
        tokenCount: cacheInfo.tokenCount,
      });
    } catch (err) {
      console.warn(`⚠️ Context caching unavailable for ${cfg.modelPro}, falling back to uncached: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    for (const issueNumber of targets) {
      const remainingTriages = cfg.maxProRuns - triagesPerformed;
      const remainingFastRuns = cfg.maxFastRuns - fastRunsPerformed;

      if (!cfg.skipFastPass && remainingFastRuns <= 0) {
        console.log(`⏳ Max fast runs (${cfg.maxFastRuns}) reached`);
        break;
      }

      if (remainingTriages <= 0) {
        console.log(`⏳ Max pro runs (${cfg.maxProRuns}) reached`);
        break;
      }

      try {
        const issue = await gh.getIssue(issueNumber);
        const { triageUsed, fastRunUsed } = await processIssue(
          { cfg, db, gh, gemini, stats },
          { issue, repoLabels, autoDiscover, systemPromptFast, systemPromptPro, cacheInfos, runTimestamp }
        );
        if (triageUsed) {
          triagesPerformed++;
          stats.incrementTriaged();
        } else {
          stats.incrementSkipped();
        }
        if (fastRunUsed) fastRunsPerformed++;
        consecutiveFailures = 0;
      } catch (err) {
        if (err instanceof GeminiResponseError) {
          console.warn(`#${issueNumber}: ${err.message}`);
          stats.incrementFailed();
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            console.error(`Analysis failed ${consecutiveFailures} consecutive times; stopping further processing.`);
            break;
          }
          continue;
        }
        throw err;
      }

      if (triagesPerformed >= cfg.maxProRuns) {
        console.log(`⏳ Max pro runs (${cfg.maxProRuns}) reached`);
        break;
      }

      saveDatabase(db, cfg.dbPath, cfg.dryRun);
    }
  } finally {
    for (const [, cacheInfo] of cacheInfos) {
      await gemini.deleteCache(cacheInfo.name);
    }
  }

  stats.incrementGithubApiCalls(gh.getApiCallCount());
  stats.printSummary();
  if (cfg.strictMode && stats.getFailed() > 0) {
    core.setFailed(`Strict mode enabled: ${stats.getFailed()} run(s) had errors.`);
  }
}

export async function listTargets(
  deps: ListTargetsDeps
): Promise<{ targets: number[]; autoDiscover: boolean }> {
  const { cfg, db, gh } = deps;
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return { targets: fromInput, autoDiscover: false };

  const payload = deps.payload ?? github.context.payload;
  const payloadNumber = payload?.issue?.number || payload?.pull_request?.number;
  if (payloadNumber) return { targets: [Number(payloadNumber)], autoDiscover: false };

  const issues = await gh.listOpenIssues();
  const recentlyClosedIssues = cfg.extended ? await gh.listRecentlyClosedIssues() : [];
  const closedIssuesToRecheck = filterPreviouslyTriagedClosedIssuesWithNewActivity(recentlyClosedIssues, db);
  const skipUnchanged = !cfg.extended;
  const orderedNumbers = buildAutoDiscoverQueue(issues.concat(closedIssuesToRecheck), db, skipUnchanged);
  return { targets: orderedNumbers, autoDiscover: true };
}
