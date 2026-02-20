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

function applyMultiplier(base: number, multiplier: number): number {
  return Math.max(0, Math.floor(base * multiplier));
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

  const dryRun = (core.getInput('dry-run') || 'false').toLowerCase() === 'true';
  const promptPath = core.getInput('prompt-path') || '.github/AutoTriage.prompt';
  const readmePath = core.getInput('readme-path') || 'README.md';
  const dbPath = core.getInput('db-path');
  const modelFastInput = core.getInput('model-fast');
  const modelFast = modelFastInput || 'gemini-2.5-flash';
  const skipFastPass = modelFastInput === '';
  const modelPro = core.getInput('model-pro') || 'gemini-3-flash-preview';
  const thinkingBudget = -1;
  const budgetScale = Number(core.getInput('budget-scale') || '1');
  const multiplier = Number.isFinite(budgetScale) && budgetScale >= 0 ? budgetScale : 1;
  const maxFastTimelineEvents = applyMultiplier(12, multiplier);
  const maxProTimelineEvents = applyMultiplier(40, multiplier);
  const maxFastReadmeChars = applyMultiplier(0, multiplier);
  const maxProReadmeChars = applyMultiplier(120000, multiplier);
  const maxFastIssueBodyChars = applyMultiplier(4000, multiplier);
  const maxProIssueBodyChars = applyMultiplier(20000, multiplier);
  const maxFastTimelineTextChars = applyMultiplier(600, multiplier);
  const maxProTimelineTextChars = applyMultiplier(4000, multiplier);
  const maxProRuns = Number(core.getInput('max-pro-runs') || '20');
  const maxFastRuns = Number(core.getInput('max-fast-runs') || '100');
  const issues = core.getInput('issues');
  const issueNumbers = parseNumbers(issues);
  const issueNumber = issueNumbers && issueNumbers.length === 1 ? issueNumbers[0] : undefined;
  const additionalInstructions = core.getInput('additional-instructions') || undefined;
  const contextCaching = (core.getInput('context-caching') || 'false').toLowerCase() === 'true';
  const extended = (core.getInput('extended') || 'false').toLowerCase() === 'true';
  const strictMode = (core.getInput('strict-mode') || 'false').toLowerCase() === 'true';

  return {
    owner,
    repo,
    token,
    geminiApiKey,
    dryRun,
    skipFastPass,
    thinkingBudget,

    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    readmePath,
    dbPath,
    modelFast,
    modelPro,
    maxFastTimelineEvents,
    maxProTimelineEvents,
    maxFastReadmeChars,
    maxProReadmeChars,
    maxFastIssueBodyChars,
    maxProIssueBodyChars,
    maxFastTimelineTextChars,
    maxProTimelineTextChars,
    maxProRuns: Number.isFinite(maxProRuns) && maxProRuns > 0 ? Math.floor(maxProRuns) : 20,
    maxFastRuns: Number.isFinite(maxFastRuns) && maxFastRuns > 0 ? Math.floor(maxFastRuns) : 100,
    ...(additionalInstructions ? { additionalInstructions } : {}),
    contextCaching,
    extended,
    strictMode,
  } as Config;
}
