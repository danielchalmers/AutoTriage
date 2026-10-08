import * as core from '@actions/core';
import { describeModels, getConfig } from './env';
import { loadDatabase } from './storage';
import { AnthropicClient } from './llm/anthropic';
import { GeminiClient } from './llm/gemini';
import { createModelFetch } from './llm/transport';
import type { ProviderId, ResolvedModel } from './llm/resolve';
import type { ModelClient, ModelClients } from './model';
import { GitHubClient } from './github';
import { RunStatistics } from './stats';
import { runAutoTriage } from './runner';
import { errorDetail } from './util';
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

// One client per provider, shared by both passes when they use the same one.
const clients = new Map<ProviderId, ModelClient>();
function clientFor(resolved: ResolvedModel): ModelClient {
  let client = clients.get(resolved.provider);
  if (!client) {
    if (resolved.provider === 'gemini') {
      client = new GeminiClient(resolved.apiKey ?? '');
    } else if (resolved.provider === 'anthropic') {
      client = new AnthropicClient(resolved.apiKey ?? '', createModelFetch(), resolved.baseUrl);
    } else {
      throw new Error(`The ${resolved.provider} provider is not implemented yet.`);
    }
    clients.set(resolved.provider, client);
  }
  return client;
}

const cfg = getConfig();
for (const line of describeModels(cfg.models)) console.log(line);
const db = loadDatabase(cfg.dbPath);
const gh = new GitHubClient(cfg.token, cfg.owner, cfg.repo);
const pro = clientFor(cfg.models.pro);
const models: ModelClients = { fast: cfg.models.fast ? clientFor(cfg.models.fast) : pro, pro };
const stats = new RunStatistics();
stats.setRepository(cfg.owner, cfg.repo);
stats.setModelNames(cfg.modelFast, cfg.modelPro);
stats.setProviders({
  fast: cfg.models.fast && { provider: cfg.models.fast.provider, tier: cfg.models.fast.tier },
  pro: { provider: cfg.models.pro.provider, tier: cfg.models.pro.tier },
});

runAutoTriage({ cfg, db, gh, models, stats }).catch((err) => {
  core.setFailed(errorDetail(err));
});
