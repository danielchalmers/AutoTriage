import * as core from '@actions/core';
import { AnalysisResult, Config, TriageDb } from './types';
import { getIssue, listOpenIssues, getOctokit, listRepoLabels } from './github';
import { buildMetadata, buildPrompt } from './prompt';
import { saveArtifact, writeAnalysisToDb, getPreviousReasoning } from './storage';
import { TriageOperation, planOperations } from './triage';
import { evaluateStage } from './analysis';


export async function processIssue(
  cfg: Config,
  triageDb: TriageDb,
  issueNumber: number,
  remainingOps: number
): Promise<number> {
  const octokit = getOctokit(cfg.token);
  const issue = await getIssue(octokit, cfg.owner, cfg.repo, issueNumber);
  const dbEntry = triageDb[String(issueNumber)] as TriageDb[string] | undefined;
  const lastTriaged: string | null = dbEntry?.lastTriaged || null;
  const previousReasoning: string = getPreviousReasoning(triageDb, issueNumber);

  const metadata = await buildMetadata(issue);
  const basePrompt = await buildPrompt(
    octokit,
    cfg.owner,
    cfg.repo,
    issue,
    metadata,
    lastTriaged,
    previousReasoning,
    cfg.promptPath,
    cfg.maxTimelineEvents
  );

  // Fetch repository labels for filtering proposed labels
  const repoLabels = await listRepoLabels(octokit, cfg.owner, cfg.repo);

  // Stage 1: quick (fast model)
  const quickAnalysis: AnalysisResult | null = await evaluateStage(
    cfg,
    issueNumber,
    cfg.modelFast,
    basePrompt,
    'quick'
  );
  let ops: TriageOperation[] = [];
  if (quickAnalysis) ops = planOperations(cfg, issue, quickAnalysis, metadata, repoLabels);

  // If quick succeeded and produced no operations, skip review stage entirely
  if (quickAnalysis && ops.length === 0) {
    core.info(`⏭️ #${issueNumber}: quick stage found no operations; skipping review stage.`);
    // Persist triage metadata from quick analysis even when no actions are needed
    if (cfg.dbPath && cfg.enabled) writeAnalysisToDb(triageDb, issueNumber, quickAnalysis, issue.title);
    return 0;
  }

  // If quick failed or proposed operations, evaluate review
  let reviewAnalysis: AnalysisResult | null = null;
  if (!quickAnalysis || ops.length > 0) {
    reviewAnalysis = await evaluateStage(cfg, issueNumber, cfg.modelPro, basePrompt, 'review');
    if (reviewAnalysis) {
      ops = planOperations(cfg, issue, reviewAnalysis, metadata, repoLabels);
    } else {
      ops = [];
    }
  }

  if (!reviewAnalysis) {
    core.warning(`⚠️ analysis failed for #${issueNumber}`);
    return 0;
  }

  let performedCount = 0;
  if (ops.length > 0) {
    saveArtifact(issueNumber, 'operations.json', JSON.stringify(ops.map(o => o.toJSON()), null, 2));
    if (!cfg.enabled) {
      core.info(`🧪 [dry-run] Skipping ${ops.length} operation(s) for #${issueNumber}.`);
      for (const op of ops) {
        const emoji = op.kind === 'labels' ? '🏷️' : op.kind === 'comment' ? '💬' : op.kind === 'title' ? '✏️' : op.kind === 'close' ? '🔒' : '•';
        core.info(`🧪 [dry-run] would: ${emoji} ${op.kind}`);
      }
      return 0;
    } else {
      const toExecute = Math.min(ops.length, Math.max(0, remainingOps));
      for (let i = 0; i < toExecute; i++) {
        const op = ops[i]!;
        await op.perform(octokit, cfg, issue);
        performedCount++;
      }
      if (toExecute < ops.length) {
        core.info(`⏳ Operation budget exhausted for #${issueNumber}. Executed ${toExecute}/${ops.length} planned ops.`);
      }
    }
  } else {
    core.info(`⏭️ #${issueNumber}: review stage has no actions.`);
  }

  if (cfg.dbPath && cfg.enabled) writeAnalysisToDb(triageDb, issueNumber, reviewAnalysis, issue.title);
  return performedCount;
}

export async function listTargets(cfg: Config): Promise<number[]> {
  const fromInput = cfg.issueNumbers || (cfg.issueNumber ? [cfg.issueNumber] : []);
  if (fromInput.length > 0) return fromInput;

  // If event supplies an issue or PR, prefer that
  const payload: any = (await import('@actions/github')).context.payload;
  const num = payload?.issue?.number || payload?.pull_request?.number;
  if (num) return [Number(num)];

  // Fallback to recent open items
  const octokit = getOctokit(cfg.token);
  const issues = await listOpenIssues(octokit, cfg.owner, cfg.repo);
  return issues.map(i => i.number);
}
