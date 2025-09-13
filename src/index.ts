import * as core from '@actions/core';
import { getConfig } from './env';
import type { Config, TriageDb } from './storage';
import { getPreviousReasoning, loadDatabase, saveArtifact, saveDatabase, writeAnalysisToDb } from './storage';
import { generateAnalysis, AnalysisResult } from './analysis';
import { GitHubClient } from './github';
import { GeminiClient } from './gemini';
import { buildMetadata } from './prompt';
import { TriageOperation, planOperations } from './triage';

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function run(): Promise<void> {
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
    try {
      const performed = await processIssue(cfg, db, n, remaining, repoLabels, gh, gemini);
      performedTotal += performed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'MODEL_INTERNAL_ERROR' || msg === 'MODEL_OVERLOADED' || msg === 'INVALID_RESPONSE') {
        core.warning(`⚠️ #${n}: ${msg}; waiting 30s.`);
        await sleep(30000);
        continue;
      }
      core.error(`❌ #${n}: ${msg}`);
      throw err;
    }
    if (performedTotal >= cfg.maxOperations) {
      core.info(`⏳ Max operations (${cfg.maxOperations}) reached; exiting early.`);
      break;
    }
  }

  saveDatabase(db, cfg.dbPath, cfg.enabled);
}

run();

async function processIssue(
  cfg: Config,
  triageDb: TriageDb,
  issueNumber: number,
  remainingOps: number,
  repoLabels: Array<{ name: string; description?: string | null }>,
  gh: GitHubClient,
  gemini: GeminiClient
): Promise<number> {
  const issue = await gh.getIssue(issueNumber);
  const dbEntry = triageDb[String(issueNumber)] as TriageDb[string] | undefined;
  const lastTriaged: string | null = dbEntry?.lastTriaged || null;
  const previousReasoning: string = getPreviousReasoning(triageDb, issueNumber);
  const metadata = buildMetadata(issue);
  const timelineEvents = await gh.listTimelineEvents(issue.number, cfg.maxTimelineEvents);

  // Optimization: Skip analysis entirely if we have a prior triage entry AND
  // neither the issue nor its (recent) timeline events have changed since that time.
  // This avoids unnecessary model invocations for completely unchanged items.
  if (lastTriaged) {
    const lastTriagedMs = Date.parse(lastTriaged);
    const updatedMs = issue.updated_at ? Date.parse(issue.updated_at) : 0;
    const hasIssueUpdate = updatedMs > lastTriagedMs;
    const hasNewTimelineEvent = timelineEvents.some(ev => {
      const ts = ev?.timestamp ? Date.parse(ev.timestamp) : 0;
      return ts > lastTriagedMs;
    });
    if (!hasIssueUpdate && !hasNewTimelineEvent) {
      core.info(`⏭️ #${issueNumber}: unchanged since last triage (${lastTriaged})`);
      return 0;
    }
  }

  // Pass 1: fast model
  const quickAnalysis: AnalysisResult = await generateAnalysis(
    cfg,
    gemini,
    issue,
    metadata,
    lastTriaged,
    previousReasoning,
    cfg.modelFast,
    timelineEvents,
    repoLabels
  );

  let ops: TriageOperation[] = planOperations(issue, quickAnalysis, metadata, repoLabels.map(l => l.name));

  // Fast pass produced no work: persist reasoning (so history grows) and skip expensive pass.
  if (ops.length === 0) {
    core.info(`⏭️ #${issueNumber}: ${quickAnalysis.reasoning}`);
    if (cfg.dbPath && cfg.enabled) writeAnalysisToDb(triageDb, issueNumber, quickAnalysis, issue.title);
    return 0;
  }

  const reviewAnalysis: AnalysisResult = await generateAnalysis(
    cfg,
    gemini,
    issue,
    metadata,
    lastTriaged,
    quickAnalysis.reasoning || previousReasoning,
    cfg.modelPro,
    timelineEvents,
    repoLabels
  );

  ops = planOperations(issue, reviewAnalysis, metadata, repoLabels.map(l => l.name));
  core.info(`🤖 #${issueNumber}: ${reviewAnalysis.reasoning}`);

  let performedCount = 0;
  if (ops.length > 0) {
    // Persist the concrete operation plan for later inspection / debugging.
    saveArtifact(issueNumber, 'operations.json', JSON.stringify(ops.map(o => o.toJSON()), null, 2));
    if (!cfg.enabled) {
      core.info(`🧪 [dry-run] Skipping ${ops.length} operation(s) for #${issueNumber}.`);
      for (const op of ops) {
        const emoji = op.kind === 'labels' ? '🏷️' : op.kind === 'comment' ? '💬' : op.kind === 'title' ? '✏️' : op.kind === 'state' ? '�' : '•';
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

