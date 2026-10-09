import * as core from '@actions/core';
import { describeModels, getConfig } from './env';
import { loadDatabase } from './storage';
import { ChatClient } from './llm/chat';
import type { ModelClients } from './issueProcessor';
import { GitHubClient } from './github';
import { RunStatistics } from './stats';
import { runAutoTriage } from './runner';
import type { Config } from './config';
import { errorDetail, errorMessage } from './util';
import chalk from 'chalk';

chalk.level = 3;

// Surface otherwise-silent crashes (e.g. floating promise rejections) so a failed run always leaves a diagnosable ::error:: line instead of a bare non-zero exit code.
process.on('unhandledRejection', (reason) => {
  core.setFailed(`Unhandled promise rejection: ${errorDetail(reason)}`);
});
process.on('uncaughtException', (err) => {
  core.setFailed(`Uncaught exception: ${err.stack ?? err.message}`);
  process.exit(1);
});


// A configuration error already says what to fix, so it fails without a stack.
let cfg: Config;
try {
  cfg = getConfig();
} catch (err) {
  core.setFailed(errorMessage(err));
  process.exit(1);
}
for (const line of describeModels(cfg.models)) console.log(line);
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const pro = new ChatClient(cfg.models.pro);
const models: ModelClients = { fast: cfg.models.fast ? new ChatClient(cfg.models.fast) : pro, pro };
const stats = new RunStatistics();
stats.setRepository(cfg.owner, cfg.repo);
stats.setModelNames(cfg.modelFast, cfg.modelPro);

// The runner reports model, GitHub and configuration failures itself, so anything that gets here is a bug.
runAutoTriage({ cfg, db, gh, models, stats }).catch((err) => {
  core.setFailed(errorDetail(err));
});
