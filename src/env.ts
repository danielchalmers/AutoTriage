import * as core from '@actions/core';
import * as github from '@actions/github';
import { MAX_SWEEP_ITEMS } from './autoDiscover';
import type { Config } from './config';
import { describeReasoning } from './llm/chat';
import { describeEndpoint, resolveModel, type Endpoint, type ModelEnv, type ProviderId } from './llm/endpoint';
import { DB_FILE } from './storage';

// The model each key gets when the model input is blank.
const DEFAULT_MODELS: Record<ProviderId, string> = {
  gemini: 'gemini-3.5-flash-lite',
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-6-luna',
};

/**
 * Inputs that earlier versions took, each with what to do instead.
 * GitHub passes every with: key to the action, declared or not, and only warns about undeclared ones, so without this check a removed input would be silently ignored.
 */
export const REMOVED_INPUTS: Readonly<Record<string, string>> = {
  'model-fast': 'delete it; v5 reviews every item with model',
  'model-pro': 'rename it to model',
  'max-fast-runs': 'delete it',
  'strict-mode': 'delete it; runs fail only for configuration errors and bugs',
  'prompt-path': 'delete it; the policy is always .github/AutoTriage.prompt, read through the API at the event commit',
  'max-pro-runs': `delete it; sweeps stop at ${MAX_SWEEP_ITEMS} items and explicit lists run in full`,
  extended: 'delete it; with a policy file, sweeps revisit unchanged and recently closed items',
  'budget-scale': 'delete it',
  'additional-instructions': 'move the text into .github/AutoTriage.prompt',
  'db-path': `delete it; the database is always ${DB_FILE} in the working directory, so keep that cache path`,
};

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

// GitHub exports each with: key as INPUT_<NAME> with its hyphens kept, such as INPUT_MODEL-PRO.
// Presence is what counts, so a leftover blank line such as `model-fast: ""` fails the run too.
function checkRemovedInputs(): void {
  const passed = Object.entries(REMOVED_INPUTS).filter(([name]) => process.env[`INPUT_${name.toUpperCase()}`] !== undefined);
  if (passed.length === 0) return;
  throw new Error(`Remove or rename the inputs that AutoTriage no longer takes: ${passed.map(([name, hint]) => `${name} (${hint})`).join(', ')}.`);
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

// The startup log line, which names the host because it decides where the key and the issue text go.
export function describeModel(endpoint: Endpoint): string {
  return `Model: ${describeEndpoint(endpoint)}, ${describeReasoning(endpoint.host)}.`;
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
 * Throws early with actionable messages if a removed input is passed, GITHUB_TOKEN is missing, no model API key is set or the model input is ambiguous, repo context is absent, or the dry-run or issues input has an invalid value.
 */
export function getConfig(): Config {
  checkRemovedInputs();
  const { owner, repo } = resolveWorkflowRepository();
  const token = process.env.GITHUB_TOKEN || '';

  if (!token) throw new Error('GITHUB_TOKEN missing (add: secrets.GITHUB_TOKEN).');
  // A blank model uses the default for the only key set.
  const model = resolveModel('model', core.getInput('model'), readModelEnv(), DEFAULT_MODELS);

  const dryRun = parseBooleanInput('dry-run');
  const sha = normalizeInput(github.context.sha);
  const issueNumbers = parseIssueNumbersInput('issues');

  return {
    owner,
    repo,
    token,
    dryRun,
    ...(issueNumbers ? { issueNumbers } : {}),
    ...(sha ? { sha } : {}),
    model,
  };
}
