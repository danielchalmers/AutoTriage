import * as core from '@actions/core';
import * as github from '@actions/github';
import { createHash } from 'node:crypto';
import {
  buildSystemPrompt,
  normalizeRepoLabels,
} from './analysis';
import {
  buildAutoDiscoverQueue,
  filterPreviouslyTriagedClosedIssuesWithNewActivity,
} from './autoDiscover';
import { THINKING_LEVEL } from './llm/gemini';
import type { ProviderId } from './llm/resolve';
import { ModelError, type CacheInfo, type FatalCause } from './llm/types';
import { GitHubClient } from './github';
import { IssueProcessorDeps, processIssue } from './issueProcessor';
import type { FailureReason, RunStatistics } from './stats';
import type { Config } from './config';
import { TriageDb, saveArtifact, saveDatabase } from './storage';
import { errorDetail, errorMessage } from './util';

export type AutoTriageDeps = IssueProcessorDeps;

export interface ListTargetsDeps {
  cfg: Config;
  db: TriageDb;
  gh: Pick<GitHubClient, 'listOpenIssues' | 'listRecentlyClosedIssues'>;
  payload?: any;
}

// Every run cap is reported the same way: log the remaining backlog and stamp which cap stopped the run.
function reportCapReached(stats: RunStatistics, mode: 'fast' | 'pro', maxRuns: number, remainingItems: number): void {
  console.log(`⏳ Max ${mode} runs (${maxRuns}) reached with ${remainingItems} item(s) remaining`);
  stats.setCapReached(mode);
}

// The secret that holds each provider's key, so a rejected key names the one to check.
const KEY_SECRETS: Record<ProviderId, string> = {
  gemini: 'GEMINI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

// What a fatal model error means for the run, finishing "Stopped the run because ...".
function fatalReason(cause: FatalCause, provider: ProviderId): string {
  switch (cause) {
    case 'auth':
      return `the model API rejected the API key. Check the ${KEY_SECRETS[provider]} secret`;
    case 'model':
      return 'the model API does not know the model, or the model does not support the request. Check model-fast and model-pro';
    case 'quota':
      return 'the model API account is out of credit or over its spend limit. Check its billing';
  }
}

// How a failed item is recorded in the run summary.
function failureReasonOf(err: unknown): FailureReason {
  if (!(err instanceof ModelError)) return 'other';
  return err.failure.kind === 'fatal' ? err.failure.cause : err.failure.kind;
}

// Truncated content hash so run summaries can be segmented by prompt version.
function hashPrompt(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`;
}

export async function runAutoTriage(deps: AutoTriageDeps): Promise<void> {
  const { cfg, db, gh, models, stats } = deps;
  const repoLabels = normalizeRepoLabels(await gh.listRepoLabels());
  const { targets, autoDiscover } = await listTargets({ cfg, db, gh });
  stats.setDiscovered(targets.length);
  const runTimestamp = new Date().toISOString();
  let triagesPerformed = 0;
  let fastRunsPerformed = 0;
  let consecutiveFailures = 0;
  let stoppedByFatalError = false;

  console.log(`⚙️ Running in ${cfg.dryRun ? 'dry-run' : 'live'} mode (strict: ${cfg.strictMode})`);
  console.log(`▶️ Discovered ${targets.length} item(s) from ${cfg.owner}/${cfg.repo} (extended: ${cfg.extended})`);
  console.log(`⏳ Fast runs limited to ${cfg.maxFastRuns} item(s), Pro runs limited to ${cfg.maxProRuns} item(s)`);

  const systemPromptFast = cfg.skipFastPass
    ? ''
    : buildSystemPrompt(cfg.promptPath, cfg.readmePath, repoLabels, cfg.additionalInstructions, 'fast', cfg.limits.fast);
  const systemPromptPro = buildSystemPrompt(
    cfg.promptPath,
    cfg.readmePath,
    repoLabels,
    cfg.additionalInstructions,
    'pro',
    cfg.limits.pro
  );
  saveArtifact(0, 'prompt-system-fast.md', systemPromptFast);
  saveArtifact(0, 'prompt-system.md', systemPromptPro);

  stats.setRunConfig({
    dryRun: cfg.dryRun,
    extended: cfg.extended,
    skipFastPass: cfg.skipFastPass,
    maxFastRuns: cfg.maxFastRuns,
    maxProRuns: cfg.maxProRuns,
    thinkingLevel: THINKING_LEVEL.toLowerCase(),
  });
  stats.setPromptHashes({
    fast: cfg.skipFastPass ? null : hashPrompt(systemPromptFast),
    pro: hashPrompt(systemPromptPro),
  });

  const cacheInfos: Map<'fast' | 'pro', CacheInfo> = new Map();
  if (autoDiscover) {
    const cacheTargets = [
      ...(cfg.skipFastPass ? [] : [{ mode: 'fast' as const, modelName: cfg.modelFast, systemPrompt: systemPromptFast }]),
      { mode: 'pro' as const, modelName: cfg.modelPro, systemPrompt: systemPromptPro },
    ];
    for (const { mode, modelName, systemPrompt } of cacheTargets) {
      try {
        const cacheInfo = await models[mode].createCache(modelName, systemPrompt, `autotriage-${mode}-${cfg.owner}/${cfg.repo}`);
        // A host that offers no cache, such as an OPENAI_BASE_URL endpoint, is expected, so it isn't warned about.
        if (!cacheInfo) continue;
        cacheInfos.set(mode, cacheInfo);
        stats.trackCacheCreate({ mode, model: modelName, name: cacheInfo.name, tokenCount: cacheInfo.tokenCount });
      } catch (err) {
        console.warn(`⚠️ Context caching unavailable for ${modelName}, falling back to uncached: ${errorMessage(err)}`);
      }
    }
  }

  try {
    for (const [index, issueNumber] of targets.entries()) {
      const remainingTriages = cfg.maxProRuns - triagesPerformed;
      const remainingFastRuns = cfg.maxFastRuns - fastRunsPerformed;
      const remainingItems = targets.length - index;

      if (!cfg.skipFastPass && remainingFastRuns <= 0) {
        reportCapReached(stats, 'fast', cfg.maxFastRuns, remainingItems);
        break;
      }

      if (remainingTriages <= 0) {
        reportCapReached(stats, 'pro', cfg.maxProRuns, remainingItems);
        break;
      }

      try {
        stats.beginPass(null);
        const issue = await gh.getIssue(issueNumber);
        const { triageUsed, fastRunUsed, skipped } = await processIssue(
          { cfg, db, gh, models, stats },
          { issue, repoLabels, autoDiscover, systemPromptFast, systemPromptPro, cacheInfos, runTimestamp }
        );
        if (triageUsed) triagesPerformed++;
        if (triageUsed && !skipped) {
          stats.incrementTriaged();
        } else {
          stats.incrementSkipped();
        }
        if (fastRunUsed) fastRunsPerformed++;
        consecutiveFailures = 0;
      } catch (err) {
        // Any per-item failure, model or otherwise (e.g. a transient GitHub API error), is recorded and skipped so one bad item can't abort the remaining backlog.
        // The consecutive-failure breaker below still stops the run if errors cascade (an outage, a cache that expired mid-run).
        // A fatal model error (bad key, unknown model, no credit) would fail every later item too, so it stops the run and fails the job at once, even outside strict mode.
        const failure = err instanceof ModelError ? err.failure : undefined;
        if (err instanceof ModelError && failure?.kind === 'fatal') {
          core.error(`#${issueNumber}: ${err.message}`, { title: 'Fatal model error' });
        } else if (err instanceof ModelError) {
          console.warn(`#${issueNumber}: ${err.message}`);
        } else {
          console.warn(`#${issueNumber}: unexpected error: ${errorDetail(err)}`);
        }
        stats.incrementFailed();
        const failedPass = stats.getCurrentPass();
        stats.recordItem({
          issueNumber,
          outcome: 'failed',
          escalatedToPro: failedPass === 'pro',
          failedPass: failedPass ?? undefined,
          failureReason: failureReasonOf(err),
        });
        if (failure?.kind === 'fatal') {
          const provider = (failedPass && cfg.models[failedPass] || cfg.models.pro).provider;
          core.setFailed(`Stopped the run because ${fatalReason(failure.cause, provider)}.`);
          stoppedByFatalError = true;
          break;
        }
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          console.error(`Analysis failed ${consecutiveFailures} consecutive times; stopping further processing.`);
          break;
        }
        continue;
      }

      saveDatabase(db, cfg.dbPath, cfg.dryRun);

      if (triagesPerformed >= cfg.maxProRuns) {
        reportCapReached(stats, 'pro', cfg.maxProRuns, targets.length - index - 1);
        break;
      }
    }
  } finally {
    for (const [mode, cacheInfo] of cacheInfos) {
      await models[mode].deleteCache(cacheInfo.name);
    }
    // Emit run telemetry even when the run aborts, so failed runs remain researchable.
    stats.incrementGithubApiCalls(gh.getApiCallCount());
    stats.printSummary();
    saveArtifact(0, 'run-summary.json', JSON.stringify(stats.toJSON(), null, 2));
  }

  if (cfg.strictMode && !stoppedByFatalError && stats.getFailed() > 0) {
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
