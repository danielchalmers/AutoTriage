import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config } from './config';

const DEFAULTS = {
  promptPath: '.github/AutoTriage.prompt',
  readmePath: 'README.md',
  modelFast: '',
  modelPro: 'gemini-3.1-flash-lite',
  budgetScale: 1,
  maxProRuns: 20,
  maxFastRuns: 100,
  fast: {
    timelineEvents: 12,
    readmeChars: 0,
    issueBodyChars: 4000,
    timelineTextChars: 600,
  },
  pro: {
    timelineEvents: 40,
    readmeChars: 120000,
    issueBodyChars: 20000,
    timelineTextChars: 4000,
  },
} as const;

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
    return { modelFast: DEFAULTS.modelFast, skipFastPass: true };
  }
  return { modelFast: normalized, skipFastPass: false };
}

function applyMultiplier(base: number, multiplier: number): number {
  return Math.max(0, Math.floor(base * multiplier));
}

function scaledPromptLimits(multiplier: number) {
  return {
    maxFastTimelineEvents: applyMultiplier(DEFAULTS.fast.timelineEvents, multiplier),
    maxProTimelineEvents: applyMultiplier(DEFAULTS.pro.timelineEvents, multiplier),
    maxFastReadmeChars: applyMultiplier(DEFAULTS.fast.readmeChars, multiplier),
    maxProReadmeChars: applyMultiplier(DEFAULTS.pro.readmeChars, multiplier),
    maxFastIssueBodyChars: applyMultiplier(DEFAULTS.fast.issueBodyChars, multiplier),
    maxProIssueBodyChars: applyMultiplier(DEFAULTS.pro.issueBodyChars, multiplier),
    maxFastTimelineTextChars: applyMultiplier(DEFAULTS.fast.timelineTextChars, multiplier),
    maxProTimelineTextChars: applyMultiplier(DEFAULTS.pro.timelineTextChars, multiplier),
  };
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
  const promptPath = parseInputOrDefault('prompt-path', DEFAULTS.promptPath);
  const readmePath = DEFAULTS.readmePath;
  const dbPath = parseOptionalInput('db-path');
  const { modelFast, skipFastPass } = parseModelFastInput();
  const modelPro = parseInputOrDefault('model-pro', DEFAULTS.modelPro);
  const multiplier = parseBudgetScaleInput('budget-scale', DEFAULTS.budgetScale);
  const promptLimits = scaledPromptLimits(multiplier);
  const maxProRuns = parsePositiveIntegerInput('max-pro-runs', DEFAULTS.maxProRuns);
  const maxFastRuns = parsePositiveIntegerInput('max-fast-runs', DEFAULTS.maxFastRuns);
  const issueNumbers = parsePositiveIntegerList(core.getInput('issues'));
  const issueNumber = issueNumbers?.length === 1 ? issueNumbers[0] : undefined;
  const additionalInstructions = parseOptionalInput('additional-instructions');
  const extended = parseBooleanInput('extended');
  const strictMode = parseBooleanInput('strict-mode');

  return {
    owner,
    repo,
    token,
    geminiApiKey,
    dryRun,
    skipFastPass,

    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    readmePath,
    ...(dbPath ? { dbPath } : {}),
    modelFast,
    modelPro,
    ...promptLimits,
    maxProRuns,
    maxFastRuns,
    ...(additionalInstructions ? { additionalInstructions } : {}),
    extended,
    strictMode,
  };
}
