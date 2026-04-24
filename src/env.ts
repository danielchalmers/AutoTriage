import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from './config';

const DEFAULT_PROMPT_PATH = '.github/AutoTriage.prompt';
const DEFAULT_README_PATH = 'README.md';
const DEFAULT_MODEL_FAST = 'gemini-3.1-flash-lite-preview';
const DEFAULT_MODEL_PRO = 'gemini-3.1-pro-preview';
const DEFAULT_BUDGET_SCALE = 1;
const DEFAULT_MAX_PRO_RUNS = 20;
const DEFAULT_MAX_FAST_RUNS = 100;

function normalizeInput(input?: string): string | undefined {
  const normalized = input?.trim();
  return normalized ? normalized : undefined;
}

function parseBooleanInput(name: string, defaultValue = false): boolean {
  const normalized = normalizeInput(core.getInput(name));
  if (!normalized) return defaultValue;
  return normalized.toLowerCase() === 'true';
}

function parsePositiveInteger(input?: string): number | undefined {
  const normalized = normalizeInput(input);
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parsePositiveIntegerInput(name: string, defaultValue: number): number {
  return parsePositiveInteger(core.getInput(name)) ?? defaultValue;
}

function parsePositiveIntegerList(input?: string): number[] | undefined {
  if (!input) return undefined;
  const numbers = input
    .split(/[\s,]+/)
    .map((part) => parsePositiveInteger(part))
    .filter((value): value is number => value !== undefined);
  return numbers.length > 0 ? numbers : undefined;
}

function parseBudgetScaleInput(name: string, defaultValue: number): number {
  const normalized = normalizeInput(core.getInput(name));
  if (!normalized) return defaultValue;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function parseInputOrDefault(name: string, defaultValue: string): string {
  return normalizeInput(core.getInput(name)) ?? defaultValue;
}

function parseOptionalInput(name: string): string | undefined {
  return normalizeInput(core.getInput(name));
}

function parseModelFastInput(): { modelFast: string; skipFastPass: boolean } {
  const normalized = normalizeInput(core.getInput('model-fast'));
  if (!normalized) {
    return { modelFast: DEFAULT_MODEL_FAST, skipFastPass: true };
  }
  return { modelFast: normalized, skipFastPass: false };
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

  const dryRun = parseBooleanInput('dry-run');
  const promptPath = parseInputOrDefault('prompt-path', DEFAULT_PROMPT_PATH);
  const readmePath = parseInputOrDefault('readme-path', DEFAULT_README_PATH);
  const dbPath = parseOptionalInput('db-path');
  const { modelFast, skipFastPass } = parseModelFastInput();
  const modelPro = parseInputOrDefault('model-pro', DEFAULT_MODEL_PRO);
  const thinkingBudget = -1;
  const multiplier = parseBudgetScaleInput('budget-scale', DEFAULT_BUDGET_SCALE);
  const maxFastTimelineEvents = applyMultiplier(12, multiplier);
  const maxProTimelineEvents = applyMultiplier(40, multiplier);
  const maxFastReadmeChars = applyMultiplier(0, multiplier);
  const maxProReadmeChars = applyMultiplier(120000, multiplier);
  const maxFastIssueBodyChars = applyMultiplier(4000, multiplier);
  const maxProIssueBodyChars = applyMultiplier(20000, multiplier);
  const maxFastTimelineTextChars = applyMultiplier(600, multiplier);
  const maxProTimelineTextChars = applyMultiplier(4000, multiplier);
  const maxProRuns = parsePositiveIntegerInput('max-pro-runs', DEFAULT_MAX_PRO_RUNS);
  const maxFastRuns = parsePositiveIntegerInput('max-fast-runs', DEFAULT_MAX_FAST_RUNS);
  const issueNumbers = parsePositiveIntegerList(core.getInput('issues'));
  const issueNumber = issueNumbers?.length === 1 ? issueNumbers[0] : undefined;
  const additionalInstructions = parseOptionalInput('additional-instructions');
  const contextCaching = parseBooleanInput('context-caching');
  const extended = parseBooleanInput('extended');
  const strictMode = parseBooleanInput('strict-mode');

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
    ...(dbPath ? { dbPath } : {}),
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
    maxProRuns,
    maxFastRuns,
    ...(additionalInstructions ? { additionalInstructions } : {}),
    contextCaching,
    extended,
    strictMode,
  };
}
