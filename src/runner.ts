import * as core from '@actions/core';
import { AnalysisResult, Config, TriageDb } from './types';
import { getIssue, listOpenIssues, getOctokit, isBot, addLabels, removeLabel, createComment, updateTitle, closeIssue } from './github';
import { buildMetadata, buildPrompt } from './prompt';
import { callGemini } from './gemini';
import { saveArtifact } from './artifacts';
import { ActionPlan } from './types';
import { buildActionPlan } from './planner';

 

async function executeActions(
  cfg: Config,
  issue: any,
  plan: ActionPlan
): Promise<void> {
  const octokit = getOctokit(cfg.token);

  if (plan.labels) {
    const { toAdd, toRemove, merged } = plan.labels;
    if (toAdd.length || toRemove.length) {
      core.info(`Labels => ${merged.join(', ')}`);
      if (cfg.enabled) {
        if (toAdd.length) await addLabels(octokit, cfg.owner, cfg.repo, issue.number, toAdd);
        for (const name of toRemove) await removeLabel(octokit, cfg.owner, cfg.repo, issue.number, name);
      }
    }
  }

  if (plan.commentBody) {
    core.info(`Comment: ${plan.commentBody.substring(0, 120)}...`);
    if (cfg.enabled) await createComment(octokit, cfg.owner, cfg.repo, issue.number, plan.commentBody);
  }

  if (plan.newTitle && plan.newTitle !== issue.title) {
    core.info(`Title: "${issue.title}" -> "${plan.newTitle}"`);
    if (cfg.enabled) await updateTitle(octokit, cfg.owner, cfg.repo, issue.number, plan.newTitle);
  }

  if (plan.close === true) {
    core.info('Closing issue');
    if (cfg.enabled) await closeIssue(octokit, cfg.owner, cfg.repo, issue.number, 'not_planned');
  }
}

type StageName = 'plan' | 'final';

function buildRunSection(stage: StageName, model: string): string {
  return `
=== SECTION: RUN MODE ===
Stage: ${stage}
Model: ${model}
Task: Propose all actions you would take based on the instructions above.
If you would take no actions, return required fields but omit all optional fields.
`;
}

async function evaluateStage(
  cfg: Config,
  issueNumber: number,
  model: string,
  basePrompt: string,
  stage: StageName
): Promise<AnalysisResult | null> {
  const prompt = `${basePrompt}\n${buildRunSection(stage, model)}`;
  saveArtifact(issueNumber, `gemini-input-${model}.${stage}.md`, prompt);
  try {
    const res = await callGemini(prompt, model, cfg.geminiApiKey, issueNumber);
    saveArtifact(issueNumber, `analysis-${model}.${stage}.json`, JSON.stringify(res, null, 2));
    core.info(`${model} [${stage}] OK for #${issueNumber}`);
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`${model} [${stage}] failed for #${issueNumber}: ${message}`);
    return null;
  }
}

export async function processSingle(
  cfg: Config,
  triageDb: TriageDb,
  issueNumber: number
) {
  const octokit = getOctokit(cfg.token);
  const issue = await getIssue(octokit, cfg.owner, cfg.repo, issueNumber);

  if (isBot(issue)) {
    core.info(`#${issueNumber} created by bot; skipping.`);
    return;
  }

  const dbEntry = triageDb[String(issueNumber)] as TriageDb[string] | undefined;
  const lastTriaged: string | null = dbEntry?.lastTriaged || null;
  const previousReasoning: string = dbEntry?.reason || '';

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

  // Stage 1: plan (fast model)
  const first = await evaluateStage(cfg, issueNumber, cfg.modelFast, basePrompt, 'plan');
  let firstHasActions = false;
  if (first) {
    const [, hasActions] = buildActionPlan(cfg, issue, first, metadata);
    firstHasActions = hasActions;
  }

  // If first stage succeeded and has no actions, skip second stage
  if (first && !firstHasActions) {
    core.info(`#${issueNumber}: planning stage found no actions; skipping final stage.`);
    return;
  }

  // Stage 2: final stage model. Only this stage's plan can be executed
  const second = await evaluateStage(cfg, issueNumber, cfg.modelPro, basePrompt, 'final');
  let finalPlan: ActionPlan | null = null;
  let finalHasActions = false;
  if (second) {
    const [plan, hasActions] = buildActionPlan(cfg, issue, second, metadata);
    finalPlan = plan;
    finalHasActions = hasActions;
  }

  const finalAnalysis = second || first; // For auditing; actions only from second
  if (!finalAnalysis) {
    core.warning(`analysis failed for #${issueNumber}`);
    return;
  }

  // Persist the chosen analysis for auditing
  saveArtifact(issueNumber, 'analysis-final.json', JSON.stringify(finalAnalysis, null, 2));
  if (finalPlan && finalHasActions) {
    saveArtifact(issueNumber, 'actions-final.json', JSON.stringify(finalPlan, null, 2));
    await executeActions(cfg, issue, finalPlan);
  } else {
    core.info(`#${issueNumber}: final plan has no actions.`);
  }

  if (cfg.dbPath && cfg.enabled) {
    triageDb[issueNumber] = {
      lastTriaged: new Date().toISOString(),
      reason: finalAnalysis.reason || 'no reason',
      labels: Array.isArray(finalAnalysis.labels) ? finalAnalysis.labels : [],
    };
  }
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
