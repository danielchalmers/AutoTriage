import * as core from '@actions/core';
import { getConfig } from './env';
import type { Config, TriageDb } from './storage';
import { getPreviousReasoning, loadDatabase, saveArtifact, saveDatabase, writeAnalysisToDb } from './storage';
import { generateAnalysis, AnalysisResult } from './analysis';
import { GitHubClient } from './github';
import { GeminiClient } from './gemini';
import { buildMetadata } from './prompt';
import { TriageOperation, planOperations } from './triage';

async function run(): Promise<void> {
  try {
    const cfg = getConfig();
    core.info(`⚙️ Enabled: ${cfg.enabled ? 'true' : 'false'} (dry-run if false)`);
    core.info(`📦 Repo: ${cfg.owner}/${cfg.repo}`);

    const db = loadDatabase(cfg.dbPath);
    const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
    const gemini = new GeminiClient(cfg.geminiApiKey);
    const repoLabels = await gh.listRepoLabels();
    const targets = await listTargets(cfg, gh);
    let performedTotal = 0;

    core.info(`▶️ Processing ${targets.length} item(s)`);
    for (const n of targets) {
      const remaining = cfg.maxOperations - performedTotal;
      if (remaining <= 0) {
        core.info(`⏳ Max operations (${cfg.maxOperations}) reached; exiting early.`);
        break;
      }
  const performed = await processIssue(cfg, db, n, remaining, repoLabels, gh, gemini);
      performedTotal += performed;
      if (performedTotal >= cfg.maxOperations) {
        core.info(`⏳ Max operations (${cfg.maxOperations}) reached; exiting early.`);
        break;
      }
    }

    saveDatabase(db, cfg.dbPath, cfg.enabled);
  } catch (err: any) {
    // Enrich failure output with HTTP + request metadata when available.
    const status = err?.status || err?.response?.status;
    const method = err?.request?.method;
    const url = err?.request?.url;
    const reqId = err?.response?.headers?.['x-github-request-id'];
    if (status || method || url) {
      if (status) core.error(`💥 HTTP ${status}`);
      if (method && url) core.error(`💥 ${method} ${url}`);
      if (reqId) core.error(`💥 x-github-request-id: ${reqId}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

run();

async function processIssue(
  cfg: Config,
  triageDb: TriageDb,
  issueNumber: number,
  remainingOps: number,
  repoLabels: string[],
  gh: GitHubClient,
  gemini: GeminiClient
): Promise<number> {
  const issue = await gh.getIssue(issueNumber);
  const dbEntry = triageDb[String(issueNumber)] as TriageDb[string] | undefined;
  const lastTriaged: string | null = dbEntry?.lastTriaged || null;
  const previousReasoning: string = getPreviousReasoning(triageDb, issueNumber);
  const metadata = buildMetadata(issue);
  const timelineEvents = await gh.listTimelineEvents(issue.number, cfg.maxTimelineEvents);

  // Pass 1: fast model
  const quickAnalysis = await generateAnalysis(
    cfg,
    gemini,
    issue,
    metadata,
    lastTriaged,
    previousReasoning,
    cfg.modelFast,
    timelineEvents
  );
  let ops: TriageOperation[] = quickAnalysis
    ? planOperations(issue, quickAnalysis, metadata, repoLabels)
    : [];

  // Fast pass produced no work: persist reasoning (so history grows) and skip expensive pass.
  if (quickAnalysis && ops.length === 0) {
    core.info(`⏭️ #${issueNumber}: Quick stage found no operations; skipping review stage.`);
    // Persist triage metadata from quick analysis even when no actions are needed
    if (cfg.dbPath && cfg.enabled) writeAnalysisToDb(triageDb, issueNumber, quickAnalysis, issue.title);
    return 0;
  }

  // Only escalate to the pro model if fast pass failed or wants to change something.
  let reviewAnalysis: AnalysisResult | null = null;
  if (!quickAnalysis || ops.length > 0) {
    reviewAnalysis = await generateAnalysis(
      cfg,
      gemini,
      issue,
      metadata,
      lastTriaged,
      quickAnalysis?.reasoning || previousReasoning,
      cfg.modelPro,
      timelineEvents
    );
    if (reviewAnalysis) {
      ops = planOperations(issue, reviewAnalysis, metadata, repoLabels);
    } else {
      ops = [];
    }
  }

  if (!reviewAnalysis) {
    core.warning(`⚠️ Analysis failed for #${issueNumber}`);
    return 0;
  }

  let performedCount = 0;
  if (ops.length > 0) {
    // Persist the concrete operation plan for later inspection / debugging.
    saveArtifact(issueNumber, 'operations.json', JSON.stringify(ops.map(o => o.toJSON()), null, 2));
    if (!cfg.enabled) {
      core.info(`🧪 [dry-run] Skipping ${ops.length} operation(s) for #${issueNumber}.`);
      for (const op of ops) {
        const emoji = op.kind === 'labels' ? '🏷️' : op.kind === 'comment' ? '💬' : op.kind === 'title' ? '✏️' : op.kind === 'close' ? '🔒' : op.kind === 'reopen' ? '🔓' : '•';
        core.info(`🧪 [dry-run] Would: ${emoji} ${op.kind}`);
      }
      return 0;
    } else {
      const toExecute = Math.min(ops.length, Math.max(0, remainingOps));
      for (let i = 0; i < toExecute; i++) {
        const op = ops[i]!;
        await op.perform(gh, cfg, issue);
        performedCount++;
      }
      if (toExecute < ops.length) {
        core.info(`⏳ Operation budget exhausted for #${issueNumber}. Executed ${toExecute}/${ops.length} planned ops.`);
      }
    }
  } else {
    core.info(`⏭️ #${issueNumber}: Review stage has no actions.`);
  }

  if (cfg.dbPath && cfg.enabled) writeAnalysisToDb(triageDb, issueNumber, reviewAnalysis, issue.title);
  return performedCount;
}

async function listTargets(cfg: Config, gh: GitHubClient): Promise<number[]> {
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return fromInput;

  // Event payload single target (issue or PR) takes priority over fallback listing.
  const payload: any = (await import('@actions/github')).context.payload;
  const num = payload?.issue?.number || payload?.pull_request?.number;
  if (num) return [Number(num)];

  // Fallback: process all open issues/PRs (ordered recent first) when nothing explicit given.
  const issues = await gh.listOpenIssues();
  return issues.map(i => i.number);
}

