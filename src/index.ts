import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase } from './storage';
import { GeminiClient } from './gemini';
import { GitHubClient } from './github';
import { initializeRunStatistics } from './stats';
import { runAutoTriage } from './runner';
import chalk from 'chalk';

chalk.level = 3;

const cfg = getConfig();
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const gemini = new GeminiClient(cfg.geminiApiKey);
initializeRunStatistics({
  owner: cfg.owner,
  repo: cfg.repo,
  modelFast: cfg.modelFast,
  modelPro: cfg.modelPro,
});

runAutoTriage({ cfg, db, gh, gemini }).catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
