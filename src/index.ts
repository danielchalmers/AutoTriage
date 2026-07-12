import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase } from './storage';
import { GeminiClient } from './gemini';
import { GitHubClient } from './github';
import { RunStatistics } from './stats';
import { runAutoTriage } from './runner';
import chalk from 'chalk';

chalk.level = 3;

// Surface otherwise-silent crashes (e.g. floating promise rejections) so a
// failed run always leaves a diagnosable ::error:: line instead of a bare
// non-zero exit code.
process.on('unhandledRejection', (reason) => {
  core.setFailed(`Unhandled promise rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
process.on('uncaughtException', (err) => {
  core.setFailed(`Uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});

const cfg = getConfig();
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const gemini = new GeminiClient(cfg.geminiApiKey);
const stats = new RunStatistics();
stats.setRepository(cfg.owner, cfg.repo);
stats.setModelNames(cfg.modelFast, cfg.modelPro);

runAutoTriage({ cfg, db, gh, gemini, stats }).catch((err) => {
  core.setFailed(err instanceof Error ? err.stack ?? err.message : String(err));
});
