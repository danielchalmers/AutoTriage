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
import type { Config } from './config';
import { TriageDb, saveDatabase, saveSharedArtifact } from './storage';

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

export interface AutoDiscoverDebugInfo {
  openIssueNumbers: number[];
  recentlyClosedIssueNumbers: number[];
  closedIssueNumbersToRecheck: number[];
  skippedUnchangedIssueNumbers: number[];
  allIssueNumbersBeforeLimits: number[];
}

export interface TargetSelectionDebugInfo {
  source: 'explicit-input' | 'event-payload' | 'auto-discover';
  explicitIssueNumbers?: number[];
  payloadIssueNumber?: number;
  autoDiscover?: AutoDiscoverDebugInfo;
}

export async function runAutoTriage(deps: AutoTriageDeps): Promise<void> {
  const { cfg, db, gh, gemini, stats } = deps;
  const repoLabels = normalizeRepoLabels(await gh.listRepoLabels());
  const { targets, autoDiscover, debugInfo } = await listTargets({ cfg, db, gh });
  const runTimestamp = new Date().toISOString();
  let triagesPerformed = 0;
  let fastRunsPerformed = 0;
  let consecutiveFailures = 0;
  const attemptedIssueNumbers: number[] = [];
  const triagedIssueNumbers: number[] = [];
  const skippedIssueNumbers: number[] = [];
  const failedIssues: Array<{ issueNumber: number; error: string }> = [];
  let stopReason: string | undefined;
  let fatalError: string | undefined;

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
  saveSharedArtifact('prompt-system-fast.md', systemPromptFast);
  saveSharedArtifact('prompt-system.md', systemPromptPro);

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
    try {
      for (const issueNumber of targets) {
        const remainingTriages = cfg.maxProRuns - triagesPerformed;
        const remainingFastRuns = cfg.maxFastRuns - fastRunsPerformed;

        if (!cfg.skipFastPass && remainingFastRuns <= 0) {
          stopReason = `max-fast-runs reached (${cfg.maxFastRuns})`;
          console.log(`⏳ Max fast runs (${cfg.maxFastRuns}) reached`);
          break;
        }

        if (remainingTriages <= 0) {
          stopReason = `max-pro-runs reached (${cfg.maxProRuns})`;
          console.log(`⏳ Max pro runs (${cfg.maxProRuns}) reached`);
          break;
        }

        attemptedIssueNumbers.push(issueNumber);

        try {
          const issue = await gh.getIssue(issueNumber);
          const { triageUsed, fastRunUsed } = await processIssue(
            { cfg, db, gh, gemini, stats },
            { issue, repoLabels, autoDiscover, systemPromptFast, systemPromptPro, cacheInfos, runTimestamp }
          );
          if (triageUsed) {
            triagesPerformed++;
            triagedIssueNumbers.push(issueNumber);
            stats.incrementTriaged();
          } else {
            skippedIssueNumbers.push(issueNumber);
            stats.incrementSkipped();
          }
          if (fastRunUsed) fastRunsPerformed++;
          consecutiveFailures = 0;
        } catch (err) {
          if (err instanceof GeminiResponseError) {
            console.warn(`#${issueNumber}: ${err.message}`);
            failedIssues.push({ issueNumber, error: err.message });
            stats.incrementFailed();
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
              stopReason = `stopped after ${consecutiveFailures} consecutive Gemini failures`;
              console.error(`Analysis failed ${consecutiveFailures} consecutive times; stopping further processing.`);
              break;
            }
            continue;
          }
          fatalError = err instanceof Error ? err.message : String(err);
          throw err;
        }

        if (triagesPerformed >= cfg.maxProRuns) {
          stopReason = `max-pro-runs reached (${cfg.maxProRuns})`;
          console.log(`⏳ Max pro runs (${cfg.maxProRuns}) reached`);
          break;
        }

        saveDatabase(db, cfg.dbPath, cfg.dryRun);
      }
    } catch (err) {
      fatalError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  } finally {
    const attemptedSet = new Set(attemptedIssueNumbers);
    const remainingIssueNumbers = targets.filter((issueNumber) => !attemptedSet.has(issueNumber));
    saveSharedArtifact('run-debug.json', JSON.stringify({
      generatedAt: runTimestamp,
      repository: `${cfg.owner}/${cfg.repo}`,
      selection: debugInfo,
      limits: {
        maxFastRuns: cfg.maxFastRuns,
        maxProRuns: cfg.maxProRuns,
        skipFastPass: cfg.skipFastPass,
      },
      run: {
        autoDiscover,
        dryRun: cfg.dryRun,
        extended: cfg.extended,
        attemptedIssueNumbers,
        triagedIssueNumbers,
        skippedIssueNumbers,
        failedIssues,
        remainingIssueNumbers,
        stopReason,
        fatalError,
      },
    }, null, 2));
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
): Promise<{ targets: number[]; autoDiscover: boolean; debugInfo: TargetSelectionDebugInfo }> {
  const { cfg, db, gh } = deps;
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) {
    return {
      targets: fromInput,
      autoDiscover: false,
      debugInfo: {
        source: 'explicit-input',
        explicitIssueNumbers: fromInput,
      },
    };
  }

  const payload = deps.payload ?? github.context.payload;
  const payloadNumber = payload?.issue?.number || payload?.pull_request?.number;
  if (payloadNumber) {
    return {
      targets: [Number(payloadNumber)],
      autoDiscover: false,
      debugInfo: {
        source: 'event-payload',
        payloadIssueNumber: Number(payloadNumber),
      },
    };
  }

  const issues = await gh.listOpenIssues();
  const recentlyClosedIssues = cfg.extended ? await gh.listRecentlyClosedIssues() : [];
  const closedIssuesToRecheck = filterPreviouslyTriagedClosedIssuesWithNewActivity(recentlyClosedIssues, db);
  const skipUnchanged = !cfg.extended;
  const combinedIssues = issues.concat(closedIssuesToRecheck);
  const allIssueNumbersBeforeLimits = buildAutoDiscoverQueue(combinedIssues, db, false);
  const orderedNumbers = buildAutoDiscoverQueue(combinedIssues, db, skipUnchanged);
  const selectedSet = new Set(orderedNumbers);
  const skippedUnchangedIssueNumbers = skipUnchanged
    ? allIssueNumbersBeforeLimits.filter((issueNumber) => !selectedSet.has(issueNumber))
    : [];
  return {
    targets: orderedNumbers,
    autoDiscover: true,
    debugInfo: {
      source: 'auto-discover',
      autoDiscover: {
        openIssueNumbers: issues.map((issue) => issue.number),
        recentlyClosedIssueNumbers: recentlyClosedIssues.map((issue) => issue.number),
        closedIssueNumbersToRecheck: closedIssuesToRecheck.map((issue) => issue.number),
        skippedUnchangedIssueNumbers,
        allIssueNumbersBeforeLimits,
      },
    },
  };
}
