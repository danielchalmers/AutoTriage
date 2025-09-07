import * as core from '@actions/core';
import * as github from '@actions/github';
import { Config } from './types';

function parseNumbers(input?: string): number[] | undefined {
  if (!input) return undefined;
  const parts = input.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const nums = parts.map(p => Number(p)).filter(n => Number.isFinite(n));
  return nums.length ? nums : undefined;
}

export function getConfig(): Config {
  const { owner, repo } = github.context.repo;
  const token = process.env.GITHUB_TOKEN || '';
  const geminiApiKey = process.env.GEMINI_API_KEY || '';

  if (!token) {
    throw new Error('GITHUB_TOKEN is missing. Provide via env using secrets.GITHUB_TOKEN.');
  }
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is missing. Add it as a repository secret.');
  }

  const enabled = (core.getInput('enabled') || 'true').toLowerCase() === 'true';
  const promptPath = core.getInput('prompt-path') || '.github/scripts/AutoTriage.prompt';
  const dbPath = core.getInput('db-path') || undefined;
  const modelFast = core.getInput('model-fast') || 'gemini-2.5-flash';
  const modelPro = core.getInput('model-pro') || 'gemini-2.5-pro';
  const modelTemperature = (() => {
    const n = Number(core.getInput('model-temperature') || '1.0');
    return Number.isFinite(n) ? n : 1.0;
  })();
  const maxTimelineEvents = Number(core.getInput('max-timeline-events') || '50');
  const maxOperations = Number(core.getInput('max-operations') || '10');

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
    ...(issueNumber !== undefined ? { issueNumber } : {}),
    ...(issueNumbers ? { issueNumbers } : {}),
    promptPath,
    dbPath,
    modelFast,
    modelPro,
    maxTimelineEvents: Number.isFinite(maxTimelineEvents) ? maxTimelineEvents : 50,
    maxOperations: Number.isFinite(maxOperations) && maxOperations > 0 ? Math.floor(maxOperations) : 10,
  } as Config;
}
