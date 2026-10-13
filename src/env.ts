import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Config, PromptLimits } from './config';
import { describeReasoning } from './llm/chat';
import { describeEndpoint, resolveModel, type Endpoint, type ModelEnv, type ProviderId } from './llm/endpoint';

export const DEFAULT_PROMPT_PATH = '.github/AutoTriage.prompt';
// The model each key gets when the model input is blank.
const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: 'gemini-3.5-flash-lite',
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
};
const DEFAULT_BUDGET_SCALE = 1;
const DEFAULT_MAX_RUNS = 50;

function normalizeInput(input?: string): string | undefined {
  const normalized = input?.trim();
  return normalized ? normalized : undefined;
}

// Only the YAML 1.2 boolean spellings count, so a value like 'yes' fails the run instead of quietly meaning false.
// A blank value keeps the default, because a workflow expression can evaluate to ''.
function parseBooleanInput(name: string, defaultValue = false): boolean {
  const normalized = normalizeInput(core.getInput(name));
  if (!normalized) return defaultValue;
  if (['true', 'True', 'TRUE'].includes(normalized)) return true;
  if (['false', 'False', 'FALSE'].includes(normalized)) return false;
  throw new Error(`The ${name} input must be true or false, not '${normalized}'.`);
}

function parsePositiveInteger(input?: string): number | undefined {
  const normalized = normalizeInput(input);
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// A value that isn't valid fails the run, as dry-run does, rather than quietly running with the default.
function parsePositiveIntegerInput(name: string, defaultValue: number): number {
  const normalized = normalizeInput(core.getInput(name));
  if (!normalized) return defaultValue;
  const parsed = parsePositiveInteger(normalized);
  if (parsed === undefined) throw new Error(`The ${name} input must be a whole number above 0, not '${normalized}'.`);
  return parsed;
}

// Any token that isn't an issue or PR number fails the run, so a typo can never turn an explicit list into a backlog sweep.
function parseIssueNumbersInput(name: string): number[] | undefined {
  const normalized = normalizeInput(core.getInput(name));
  if (!normalized) return undefined;

  const tokens = normalized.split(/[\s,]+/).filter(Boolean);
  const invalid = tokens.filter((token) => parsePositiveInteger(token.replace(/^#/, '')) === undefined);
  if (tokens.length === 0 || invalid.length > 0) {
    const named = (invalid.length > 0 ? invalid : [normalized]).map((token) => `'${token}'`).join(', ');
    throw new Error(`The ${name} input takes issue or PR numbers separated by spaces or commas, such as "12, #34", but got ${named}.`);
  }
  return [...new Set(tokens.map((token) => Number(token.replace(/^#/, ''))))];
}

function parseBudgetScaleInput(name: string, defaultValue: number): number {
  const normalized = normalizeInput(core.getInput(name));
  if (!normalized) return defaultValue;

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`The ${name} input must be a number of 0 or more, not '${normalized}'.`);
  return parsed;
}

function parseInputOrDefault(name: string, defaultValue: string): string {
  return normalizeInput(core.getInput(name)) ?? defaultValue;
}

function parseOptionalInput(name: string): string | undefined {
  return normalizeInput(core.getInput(name));
}

function readModelEnv(): ModelEnv {
  const env: ModelEnv = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };
  for (const key of [env.GEMINI_API_KEY, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY]) {
    if (key?.trim()) core.setSecret(key.trim());
  }
  return env;
}

export function describeModel(endpoint: Endpoint): string {
  return `Model: ${describeEndpoint(endpoint)}, ${describeReasoning(endpoint.host)}.`;
}

function applyMultiplier(base: number, multiplier: number): number {
  return Math.max(0, Math.floor(base * multiplier));
}

function scaleLimits(base: PromptLimits, multiplier: number): PromptLimits {
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
 * Throws early with actionable messages if GITHUB_TOKEN is missing, no model API key is set, repo context is absent, or a boolean or issues input has an invalid value.
 */
export function getConfig(): Config {
  const { owner, repo } = resolveWorkflowRepository();
  const token = process.env.GITHUB_TOKEN || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  const model = resolveModel('model', core.getInput('model'), readModelEnv(), DEFAULT_MODELS);

  const dryRun = parseBooleanInput('dry-run');
  const promptPath = parseInputOrDefault('prompt-path', DEFAULT_PROMPT_PATH);
  const dbPath = parseOptionalInput('db-path');
  const multiplier = parseBudgetScaleInput('budget-scale', DEFAULT_BUDGET_SCALE);
  const limits = scaleLimits({ readmeChars: 120000, issueBodyChars: 20000, timelineEvents: 40, timelineTextChars: 4000 }, multiplier);
  const maxRuns = parsePositiveIntegerInput('max-runs', DEFAULT_MAX_RUNS);
  const issueNumbers = parseIssueNumbersInput('issues');
  const additionalInstructions = parseOptionalInput('additional-instructions');

  return {
    owner,
    repo,
    token,
    dryRun,
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    ...(dbPath ? { dbPath } : {}),
    model,
    limits,
    maxRuns,
    ...(additionalInstructions ? { additionalInstructions } : {}),
  };
}
