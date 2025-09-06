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
    let performedTotal = 0;

    core.info(`Processing ${targets.length} item(s)`);
    for (const n of targets) {
      const remaining = cfg.maxOperations - performedTotal;
      if (remaining <= 0) {
        core.info(`Max operations (${cfg.maxOperations}) reached; exiting early.`);
        break;
      }
      const performed = await processIssue(cfg, db, n, remaining);
      performedTotal += performed;
      if (performedTotal >= cfg.maxOperations) {
        core.info(`Max operations (${cfg.maxOperations}) reached; exiting early.`);
        break;
      }
    }

    saveDatabase(db, cfg.dbPath, cfg.enabled);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.setFailed(message);
  }
}

run();
