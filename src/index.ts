import * as core from '@actions/core';
import { getConfig } from './env';
import { loadDatabase, saveDatabase } from './artifacts';
import { listTargets, processIssue } from './runner';

async function run(): Promise<void> {
  try {
    const cfg = getConfig();
    core.info(`Enabled: ${cfg.enabled ? 'true' : 'false'} (dry-run if false)`);

    const db = loadDatabase(cfg.dbPath);
    const targets = await listTargets(cfg);

    core.info(`Processing ${targets.length} item(s)`);
    for (const n of targets) {
      await processIssue(cfg, db, n);
    }

    saveDatabase(db, cfg.dbPath, cfg.enabled);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

run();

