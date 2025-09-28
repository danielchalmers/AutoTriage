import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from "./storage";

// Parse a space / comma separated list of integers; ignore non-numeric fragments.
function parseNumbers(input?: string): number[] | undefined {
  if (!input) return undefined;
  const parts = input.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const nums = parts.map(p => Number(p)).filter(n => Number.isFinite(n));
  return nums.length ? nums : undefined;
}

/**
 * Resolve runtime config. Throws early with actionable messages if mandatory
 * secrets (GITHUB_TOKEN, GEMINI_API_KEY) are missing or repo context is absent.
 */
export function getConfig(): Config {
  // Resolve repo context robustly
  let { owner, repo } = github.context.repo as { owner?: string; repo?: string };
  owner = owner || '';
  repo = repo || '';
  const ghRepoEnv = process.env.GITHUB_REPOSITORY || '';
  if ((!owner || !repo) && ghRepoEnv.includes('/')) {
    const [o, r] = ghRepoEnv.split('/', 2);
    if (!owner) owner = o;
    if (!repo) repo = r;
  }
  const payloadRepo: any = (github as any).context?.payload?.repository;
  if (!owner && payloadRepo?.owner?.login) owner = String(payloadRepo.owner.login);
  if (!repo && payloadRepo?.name) repo = String(payloadRepo.name);
  if (!owner || !repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
  }
  const token = process.env.GITHUB_TOKEN || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY missing (add it as a repository secret).');

  const enabled = (core.getInput('enabled') || 'true').toLowerCase() === 'true';
  const promptPath = core.getInput('prompt-path') || '.github/AutoTriage.prompt';
  const readmePath = core.getInput('readme-path') || 'README.md';
  const dbPath = core.getInput('db-path');
  const modelFast = core.getInput('model-fast') || 'gemini-flash-latest';
  const modelPro = core.getInput('model-pro') || 'gemini-2.5-pro';
  const temperatureInput = core.getInput('model-temperature');
  const parsedTemperature = Number(
    temperatureInput === undefined || temperatureInput === '' ? '0' : temperatureInput
  );
  const modelTemperature = Number.isFinite(parsedTemperature) ? parsedTemperature : 0;
  const thinkingBudget = -1;
  const maxTimelineEvents = Number(core.getInput('max-timeline-events') || '50');
  const maxTriages = Number(core.getInput('max-triages') || '20');
  const singleIssue = core.getInput('issue-number');
  const multiIssues = core.getInput('issue-numbers');
  const issueNumber = singleIssue ? Number(singleIssue) : undefined;
  const issueNumbers = parseNumbers(multiIssues);

  return {
    owner,
    repo,
    token,
    geminiApiKey,
    modelTemperature,
    enabled,
    thinkingBudget,

    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    readmePath,
    dbPath,
    modelFast,
    modelPro,
    maxTimelineEvents: Number.isFinite(maxTimelineEvents) ? maxTimelineEvents : 50,
    maxTriages: Number.isFinite(maxTriages) && maxTriages > 0 ? Math.floor(maxTriages) : 20,
  } as Config;
}
