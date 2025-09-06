import * as core from '@actions/core';
import { AnalysisResult, Config, TriageDb } from './types';
import { getIssue, listOpenIssues, getOctokit, isBot, addLabels, removeLabel, createComment, updateTitle, closeIssue } from './github';
import { buildMetadata, buildPrompt } from './prompt';
import { analyzeWithModels } from './gemini';
import { diffLabels } from './labels';
import { saveArtifact } from './artifacts';

function filterLabels(labels: string[] | undefined, allowlist?: string[]): string[] | undefined {
  if (!labels || labels.length === 0) return labels;
  if (!allowlist || allowlist.length === 0) return labels;
  const allowed = new Set(allowlist);
  return labels.filter(l => allowed.has(l));
}

async function executeActions(
  cfg: Config,
  issue: any,
  analysis: AnalysisResult,
  metadata: any
) {
  const octokit = getOctokit(cfg.token);

  if (analysis.labels) {
    const filtered = filterLabels(analysis.labels, cfg.labelAllowlist) || [];
    const { toAdd, toRemove, merged } = diffLabels(metadata.labels as string[], filtered);
    if (toAdd.length || toRemove.length) {
      core.info(`Labels => ${merged.join(', ')}`);
    }
    if (cfg.enabled) {
      if (toAdd.length) await addLabels(octokit, cfg.owner, cfg.repo, issue.number, toAdd);
      for (const name of toRemove) await removeLabel(octokit, cfg.owner, cfg.repo, issue.number, name);
    }
  }

  if (analysis.comment) {
    const body = `<!-- ${analysis.reason || 'No reasoning provided'} -->\n\n${analysis.comment}`;
    core.info(`Comment: ${analysis.comment.substring(0, 120)}...`);
    if (cfg.enabled) await createComment(octokit, cfg.owner, cfg.repo, issue.number, body);
  }

  if (analysis.newTitle && analysis.newTitle !== issue.title) {
    core.info(`Title: "${issue.title}" -> "${analysis.newTitle}"`);
    if (cfg.enabled) await updateTitle(octokit, cfg.owner, cfg.repo, issue.number, analysis.newTitle);
  }

  if (analysis.close === true) {
    core.info('Closing issue');
    if (cfg.enabled) await closeIssue(octokit, cfg.owner, cfg.repo, issue.number, 'not_planned');
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

  const dbEntry = triageDb[issueNumber] || {};
  const lastTriaged: string | null = dbEntry.lastTriaged || null;
  const previousReasoning: string = dbEntry.reason || '';

  const metadata = await buildMetadata(issue);
  const prompt = await buildPrompt(
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

  const { flash, pro } = await analyzeWithModels(prompt, issueNumber, cfg.geminiApiKey, cfg.modelFast, cfg.modelPro);

  if (flash) {
    core.info(`flash: ${flash.reason}`);
    saveArtifact(issueNumber, 'analysis-flash.json', JSON.stringify(flash, null, 2));
  }
  if (pro) {
    core.info(`pro: ${pro.reason}`);
    saveArtifact(issueNumber, 'analysis-pro.json', JSON.stringify(pro, null, 2));
  }

  const finalAnalysis = pro || flash;
  if (!finalAnalysis) {
    core.warning(`analysis failed for #${issueNumber}`);
    return;
  }

  await executeActions(cfg, issue, finalAnalysis, metadata);

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

