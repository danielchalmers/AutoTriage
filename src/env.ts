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

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
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
  const modelFastInput = core.getInput('model-fast');
  const modelFast = modelFastInput || 'gemini-2.5-flash';
  const skipFastPass = modelFastInput === '';
  const modelPro = core.getInput('model-pro') || 'gemini-3-flash-preview';
  const fastTemperatureInput = core.getInput('model-fast-temperature');
  const parsedFastTemperature = Number(
    fastTemperatureInput === undefined || fastTemperatureInput === '' ? '0.0' : fastTemperatureInput
  );
  const modelFastTemperature = Number.isFinite(parsedFastTemperature) ? parsedFastTemperature : 0;
  const proTemperatureInput = core.getInput('model-pro-temperature');
  const parsedProTemperature = Number(
    proTemperatureInput === undefined || proTemperatureInput === '' ? '1.0' : proTemperatureInput
  );
  const modelProTemperature = Number.isFinite(parsedProTemperature) ? parsedProTemperature : 0;
  const thinkingBudget = -1;
  const maxTimelineEvents = parseNonNegativeInt(core.getInput('max-timeline-events') || '40', 40);
  const maxFastTimelineEvents = parseNonNegativeInt(core.getInput('max-fast-timeline-events') || '12', 12);
  const maxProTimelineEvents = parseNonNegativeInt(core.getInput('max-pro-timeline-events') || String(maxTimelineEvents), maxTimelineEvents);
  const maxFastReadmeChars = parseNonNegativeInt(core.getInput('max-fast-readme-chars') || '0', 0);
  const maxProReadmeChars = parseNonNegativeInt(core.getInput('max-pro-readme-chars') || '120000', 120000);
  const maxFastIssueBodyChars = parseNonNegativeInt(core.getInput('max-fast-issue-body-chars') || '4000', 4000);
  const maxProIssueBodyChars = parseNonNegativeInt(core.getInput('max-pro-issue-body-chars') || '20000', 20000);
  const maxFastCommentBodyChars = parseNonNegativeInt(core.getInput('max-fast-comment-body-chars') || '600', 600);
  const maxProCommentBodyChars = parseNonNegativeInt(core.getInput('max-pro-comment-body-chars') || '4000', 4000);
  const maxFastCommitMessageChars = parseNonNegativeInt(core.getInput('max-fast-commit-message-chars') || '300', 300);
  const maxProCommitMessageChars = parseNonNegativeInt(core.getInput('max-pro-commit-message-chars') || '2000', 2000);
  const maxFastReviewTextChars = parseNonNegativeInt(core.getInput('max-fast-review-text-chars') || '600', 600);
  const maxProReviewTextChars = parseNonNegativeInt(core.getInput('max-pro-review-text-chars') || '4000', 4000);
  const maxFastPriorThoughtChars = parseNonNegativeInt(core.getInput('max-fast-prior-thought-chars') || '0', 0);
  const maxProPriorThoughtChars = parseNonNegativeInt(core.getInput('max-pro-prior-thought-chars') || '8000', 8000);
  const maxTriages = Number(core.getInput('max-triages') || '20');
  const maxFastRuns = Number(core.getInput('max-fast-runs') || '100');
  const singleIssue = core.getInput('issue-number');
  const multiIssues = core.getInput('issue-numbers');
  const issueNumber = singleIssue ? Number(singleIssue) : undefined;
  const issueNumbers = parseNumbers(multiIssues);
  const additionalInstructions = core.getInput('additional-instructions') || undefined;
  const contextCaching = (core.getInput('context-caching') || 'false').toLowerCase() === 'true';
  const skipUnchanged = (core.getInput('skip-unchanged') || 'false').toLowerCase() === 'true';
  const strictMode = (core.getInput('strict-mode') || 'false').toLowerCase() === 'true';

  return {
    owner,
    repo,
    token,
    geminiApiKey,
    modelFastTemperature,
    modelProTemperature,
    enabled,
    skipFastPass,
    thinkingBudget,

    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    readmePath,
    dbPath,
    modelFast,
    modelPro,
    maxTimelineEvents,
    maxFastTimelineEvents,
    maxProTimelineEvents,
    maxFastReadmeChars,
    maxProReadmeChars,
    maxFastIssueBodyChars,
    maxProIssueBodyChars,
    maxFastCommentBodyChars,
    maxProCommentBodyChars,
    maxFastCommitMessageChars,
    maxProCommitMessageChars,
    maxFastReviewTextChars,
    maxProReviewTextChars,
    maxFastPriorThoughtChars,
    maxProPriorThoughtChars,
    maxTriages: Number.isFinite(maxTriages) && maxTriages > 0 ? Math.floor(maxTriages) : 20,
    maxFastRuns: Number.isFinite(maxFastRuns) && maxFastRuns > 0 ? Math.floor(maxFastRuns) : 100,
    ...(additionalInstructions ? { additionalInstructions } : {}),
    contextCaching,
    skipUnchanged,
    strictMode,
  } as Config;
}
