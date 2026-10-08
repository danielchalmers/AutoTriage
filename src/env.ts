import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config, PromptPassLimits } from './config';
import { describeModel, resolveModel, type ModelEnv, type ProviderId, type ResolvedModel } from './llm/resolve';

const DEFAULT_PROMPT_PATH = '.github/AutoTriage.prompt';
const DEFAULT_README_PATH = 'README.md';
// The review model each key gets when model-pro is blank. GEMINI_API_KEY keeps the model it had before other providers were supported.
const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: 'gemini-3.5-flash-lite',
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
};
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

/**
 * The model API settings, read only from the variables resolution documents.
 * Keys are masked so a later log line can't print them.
 */
function readModelEnv(): ModelEnv {
  const env: ModelEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL,
  };
  for (const key of [env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY]) {
    if (key?.trim()) core.setSecret(key.trim());
  }
  return env;
}

/**
 * Resolve both passes' models.
 * A blank model-fast is how a workflow opts out of the screening pass, and a blank model-pro uses the default for the first key set.
 */
function resolveModels(env: ModelEnv): Config['models'] {
  const pro = resolveModel({ input: 'model-pro', value: core.getInput('model-pro'), env, defaults: DEFAULT_MODELS });
  const fastInput = parseOptionalInput('model-fast');
  const fast: ResolvedModel | null = fastInput
    ? resolveModel({ input: 'model-fast', value: fastInput, env, defaults: DEFAULT_MODELS })
    : null;
  return { fast, pro };
}

/**
 * The startup log lines that say which provider serves each pass and why.
 * e.g. `Model (pro): claude-haiku-5-5 via anthropic [official] — default for ANTHROPIC_API_KEY; set model-pro to change.`
 */
export function describeModels(models: Config['models']): string[] {
  const passes = [['fast', models.fast], ['pro', models.pro]] as const;
  return passes.flatMap(([pass, resolved]) => resolved
    ? [`Model (${pass}): ${describeModel(resolved)}${resolved.isDefault ? `; set model-${pass} to change.` : '.'}`]
    : []);
}

function applyMultiplier(base: number, multiplier: number): number {
  return Math.max(0, Math.floor(base * multiplier));
}

function scaleLimits(base: PromptPassLimits, multiplier: number): PromptPassLimits {
  return {
    readmeChars: applyMultiplier(base.readmeChars, multiplier),
    issueBodyChars: applyMultiplier(base.issueBodyChars, multiplier),
    timelineEvents: applyMultiplier(base.timelineEvents, multiplier),
    timelineTextChars: applyMultiplier(base.timelineTextChars, multiplier),
  };
}

/**
 * The repository the workflow runs in.
 * context.repo already falls back from GITHUB_REPOSITORY to the event payload, and throws when neither is available.
 */
function resolveWorkflowRepository(): { owner: string; repo: string } {
  let repository: { owner?: string; repo?: string } = {};
  try {
    repository = github.context.repo;
  } catch {
    // Reported below with an actionable message.
  }
  if (!repository.owner || !repository.repo) {
    throw new Error('Failed to resolve repository context (owner/repo). Ensure this runs in GitHub Actions with a valid repository context.');
  }
  return { owner: repository.owner, repo: repository.repo };
}

/**
 * Resolve runtime config.
 * Throws early with actionable messages if GITHUB_TOKEN is missing, no model input can be resolved to a provider with its key, or repo context is absent.
 */
export function getConfig(): Config {
  const { owner, repo } = resolveWorkflowRepository();
  const token = process.env.GITHUB_TOKEN || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  const models = resolveModels(readModelEnv());

  const dryRun = parseBooleanInput('dry-run');
  const promptPath = parseInputOrDefault('prompt-path', DEFAULT_PROMPT_PATH);
  const readmePath = DEFAULT_README_PATH;
  const dbPath = parseOptionalInput('db-path');
  const multiplier = parseBudgetScaleInput('budget-scale', DEFAULT_BUDGET_SCALE);
  // The fast pass reads a trimmed slice of the same context the pro pass gets; budget-scale moves both together.
  const limits = {
    fast: scaleLimits({ readmeChars: 0, issueBodyChars: 4000, timelineEvents: 12, timelineTextChars: 600 }, multiplier),
    pro: scaleLimits({ readmeChars: 120000, issueBodyChars: 20000, timelineEvents: 40, timelineTextChars: 4000 }, multiplier),
  };
  const maxProRuns = parsePositiveIntegerInput('max-pro-runs', DEFAULT_MAX_PRO_RUNS);
  const maxFastRuns = parsePositiveIntegerInput('max-fast-runs', DEFAULT_MAX_FAST_RUNS);
  const issueNumbers = parsePositiveIntegerList(core.getInput('issues'));
  const issueNumber = issueNumbers?.length === 1 ? issueNumbers[0] : undefined;
  const additionalInstructions = parseOptionalInput('additional-instructions');
  const extended = parseBooleanInput('extended');
  const strictMode = parseBooleanInput('strict-mode');

  return {
    owner,
    repo,
    token,
    dryRun,
    skipFastPass: models.fast === null,

    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    readmePath,
    ...(dbPath ? { dbPath } : {}),
    modelFast: models.fast?.model ?? '',
    modelPro: models.pro.model,
    models,
    limits,
    maxProRuns,
    maxFastRuns,
    ...(additionalInstructions ? { additionalInstructions } : {}),
    extended,
    strictMode,
  };
}
