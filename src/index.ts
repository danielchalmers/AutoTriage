import * as core from '@actions/core';
import { getConfig } from './env';
import type { Config, TriageDb } from './storage';
import { loadDatabase, saveArtifact, saveDatabase, writeAnalysisToDb, parseDbEntry } from './storage';
import { generateAnalysis, AnalysisResult } from './analysis';
import { GitHubClient, TimelineEvent } from './github';
import { GeminiClient, GeminiResponseError } from './gemini';
import { TriageOperation, planOperations } from './triage';

async function run(): Promise<void> {
  const cfg = getConfig();
  const db = loadDatabase(cfg.dbPath);
  const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
  const gemini = new GeminiClient(cfg.geminiApiKey);
  const repoLabels = await gh.listRepoLabels();
  const { targets, autoDiscover } = await listTargets(cfg, gh);
  let triagesPerformed = 0;
  let consecutiveFailures = 0;

  core.info(`⚙️ Enabled: ${cfg.enabled ? 'yes' : 'dry-run'}`);
  core.info(`▶️ Processing ${targets.length} item(s) from ${cfg.owner}/${cfg.repo} (${autoDiscover ? "auto-discover" : targets.map(t => `#${t}`).join(', ')})`);

  for (const n of targets) {
    const remaining = cfg.maxTriages - triagesPerformed;
    if (remaining <= 0) {
      core.info(`⏳ Max triages (${cfg.maxTriages}) reached; exiting early.`);
      break;
    }

    try {
      const triageUsed = await processIssue(cfg, db, n, repoLabels, gh, gemini, autoDiscover);
      if (triageUsed) triagesPerformed++;
      consecutiveFailures = 0; // reset on success path
    } catch (err) {
      if (err instanceof GeminiResponseError) {
        core.warning(`⚠️ #${n}: ${err.message}; skipping.`);
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          core.warning(`🛑 Encountered ${consecutiveFailures} consecutive analysis failures; stopping further processing.`);
          break;
        }
        continue;
      }
      // Re-throw non-Gemini errors to stop processing
      throw err;
    }

    if (triagesPerformed >= cfg.maxTriages) {
      core.info(`⏳ Max triages (${cfg.maxTriages}) reached; exiting early.`);
      break;
    }

    saveDatabase(db, cfg.dbPath, cfg.enabled);
  }
}

run();

async function processIssue(
  cfg: Config,
  triageDb: TriageDb,
  issueNumber: number,
  repoLabels: Array<{ name: string; description?: string | null }>,
  gh: GitHubClient,
  gemini: GeminiClient,
  autoDiscover: boolean
): Promise<boolean> {
  const issue = await gh.getIssue(issueNumber);
  const dbEntry = parseDbEntry(triageDb, issueNumber);
  const timelineEvents: TimelineEvent[] = await gh.listTimelineEvents(issue.number, cfg.maxTimelineEvents);

  if (autoDiscover) {
    // Skip items that haven't changed since last triage.
    if (!gh.hasUpdated(issue, timelineEvents, dbEntry.lastTriaged, dbEntry.reactions)) {
      return false;
    }
  }

  // Pass 1: fast model
  const quickAnalysis: AnalysisResult = await generateAnalysis(
    cfg,
    gemini,
    issue,
    dbEntry.lastTriaged,
    dbEntry.previousReasoning,
    cfg.modelFast,
    timelineEvents,
    repoLabels
  );

  let ops: TriageOperation[] = planOperations(issue, quickAnalysis, issue, repoLabels.map(l => l.name));

  // Fast pass produced no work: persist reasoning and skip expensive pass.
  if (ops.length === 0) {
    core.info(`⏭️ #${issueNumber}: ${quickAnalysis.summary} 💭 ${quickAnalysis.reasoning}`);
    writeAnalysisToDb(triageDb, issueNumber, quickAnalysis, issue.title, issue.reactions);
    return false;
  }

  const reviewAnalysis: AnalysisResult = await generateAnalysis(
    cfg,
    gemini,
    issue,
    dbEntry.lastTriaged,
    quickAnalysis.reasoning,
    cfg.modelPro,
    timelineEvents,
    repoLabels
  );

  ops = planOperations(issue, reviewAnalysis, issue, repoLabels.map(l => l.name));
  core.info(`🤖 #${issueNumber}: ${reviewAnalysis.summary} 💭 ${reviewAnalysis.reasoning}`);

  if (ops.length > 0) {
    saveArtifact(issueNumber, 'operations.json', JSON.stringify(ops.map(o => o.toJSON()), null, 2));
    for (const op of ops) {
      await op.perform(gh, cfg, issue);
    }
  }

  writeAnalysisToDb(triageDb, issueNumber, reviewAnalysis, issue.title, issue.reactions);
  // Pro review executed, so consume one triage slot.
  return true;
}

async function listTargets(cfg: Config, gh: GitHubClient): Promise<{ targets: number[], autoDiscover: boolean }> {
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return { targets: fromInput, autoDiscover: false };

  // Event payload single target (issue or PR) takes priority over fallback listing.
  const payload: any = (await import('@actions/github')).context.payload;
  const num = payload?.issue?.number || payload?.pull_request?.number;
  if (num) return { targets: [Number(num)], autoDiscover: false };

  // Fallback: process all open issues/PRs (ordered recent first) when nothing explicit given.
  const issues = await gh.listOpenIssues();
  return { targets: issues.map(i => i.number), autoDiscover: true };
}
