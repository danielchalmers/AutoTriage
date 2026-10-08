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

// TEMPORARY PROBE: how Gemini's Chat Completions endpoint applies and reports thinking. Reverted in the next commit.
async function probe(): Promise<void> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return;
  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const base = {
    model: cfg.modelPro,
    messages: [
      { role: 'system', content: 'You are a careful analyst.' },
      { role: 'user', content: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Also give the smallest prime greater than 1000 that is also 3 more than a multiple of 4. Reply as JSON.' },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } },
  };
  const variants: Record<string, object> = {
    none: {},
    low: { reasoning_effort: 'low' },
    high: { reasoning_effort: 'high' },
    thoughts: { extra_body: { google: { thinking_config: { thinking_level: 'high', include_thoughts: true } } } },
    thoughtsTop: { google: { thinking_config: { thinking_level: 'high', include_thoughts: true } } },
  };
  for (const [name, extra] of Object.entries(variants)) {
    const start = Date.now();
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ ...base, ...extra }) });
    const json: any = await response.json();
    const message = json.choices?.[0]?.message ?? {};
    console.log('PROBE', name, response.status, `${Date.now() - start}ms`, JSON.stringify(json.usage), JSON.stringify(Object.keys(message)), JSON.stringify(message.extra_content ?? null).slice(0, 300), String(message.content ?? JSON.stringify(json)).slice(0, 400));
  }
}

probe().catch(err => console.log('PROBE failed', errorDetail(err))).then(() => runAutoTriage({ cfg, db, gh, models, stats })).catch((err) => {
  core.setFailed(errorDetail(err));
});
