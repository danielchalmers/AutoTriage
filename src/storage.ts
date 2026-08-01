import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_LABEL_ONLY_PROMPT } from './prompt';
import { errorMessage } from './util';

export interface TriageDbEntry {
  lastTriaged?: string;   // ISO timestamp of when triage was completed
  lastSeenUpdatedAt?: string; // GitHub updated_at watermark already consumed
  summary?: string;       // One-line summary from analysis
}

export interface TriageDb {
  version: 2;
  items: Record<string, TriageDbEntry>;
}

function createEmptyDatabase(): TriageDb {
  return {
    version: 2,
    items: {},
  };
}

export function loadDatabase(dbPath?: string): TriageDb {
  if (!dbPath) return createEmptyDatabase();

  try {
    if (!fs.existsSync(dbPath)) return createEmptyDatabase();

    const contents = fs.readFileSync(dbPath, 'utf8');
    const parsed = contents ? JSON.parse(contents) : createEmptyDatabase();
    const db = isV2Database(parsed)
      ? normalizeV2Database(parsed)
      : migrateLegacyDatabase(parsed);
    console.info(`📊 Loaded ${dbPath} with ${Object.keys(db.items).length} entries`);
    return db;
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to load ${dbPath}: ${message}. Starting with empty database.`);
    return createEmptyDatabase();
  }
}

export function saveDatabase(db: TriageDb, dbPath?: string, dryRun?: boolean): void {
  if (!dbPath || dryRun) return;

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to save ${dbPath}: ${message}`);
  }
}

export function getDbEntry(db: TriageDb, issueNumber: number): TriageDbEntry {
  return db.items[String(issueNumber)] || {};
}

export function updateDbEntry(
  db: TriageDb,
  issueNumber: number,
  summary: string,
  options: {
    lastSeenUpdatedAt?: string | undefined;
  } = {}
): void {
  const key = String(issueNumber);
  const existing = db.items[key] || {};
  const entry: TriageDbEntry = { ...existing };

  entry.summary = summary;
  entry.lastTriaged = new Date().toISOString();
  if (options.lastSeenUpdatedAt) {
    entry.lastSeenUpdatedAt = options.lastSeenUpdatedAt;
  }

  db.items[key] = entry;
}

function isV2Database(value: unknown): value is TriageDb {
  return isRecord(value) && value.version === 2 && isRecord(value.items);
}

// Both readers walk a raw item map and keep only entries that yielded at least one recognized field.
function collectEntries(source: object, toEntry: (raw: Record<string, unknown>) => TriageDbEntry): TriageDb {
  const items: Record<string, TriageDbEntry> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isRecord(value)) continue;
    const entry = toEntry(value);
    if (Object.keys(entry).length > 0) {
      items[key] = entry;
    }
  }

  return {
    version: 2,
    items,
  };
}

function normalizeV2Database(db: TriageDb): TriageDb {
  return collectEntries(db.items, value => {
    const entry: TriageDbEntry = {};
    if (typeof value.lastTriaged === 'string') entry.lastTriaged = value.lastTriaged;
    if (typeof value.lastSeenUpdatedAt === 'string') entry.lastSeenUpdatedAt = value.lastSeenUpdatedAt;
    if (typeof value.summary === 'string') entry.summary = value.summary;
    return entry;
  });
}

function migrateLegacyDatabase(value: unknown): TriageDb {
  if (!isRecord(value)) return createEmptyDatabase();

  return collectEntries(value, legacyEntry => {
    const entry: TriageDbEntry = {};
    // Legacy rows had no separate watermark, so the triage time doubles as one.
    // Any parseable date counts, including pre-1970 ones, so keep the finite check rather than a positive-value test.
    const lastTriaged = typeof legacyEntry.lastTriaged === 'string' && Number.isFinite(Date.parse(legacyEntry.lastTriaged))
      ? legacyEntry.lastTriaged
      : undefined;

    if (lastTriaged) {
      entry.lastTriaged = lastTriaged;
      entry.lastSeenUpdatedAt = lastTriaged;
    }

    if (typeof legacyEntry.summary === 'string') {
      entry.summary = legacyEntry.summary;
    }

    return entry;
  });
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function saveArtifact(issueNumber: number, name: string, contents: string): void {
  try {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    const fileName =
      name === 'prompt-system.md' || name === 'prompt-system-fast.md'
        ? name
        : `${issueNumber}-${name}`;
    const filePath = path.join(artifactsDir, fileName);

    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to save artifact ${name} for #${issueNumber}: ${message}`);
  }
}

function resolveFromCwd(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

export function loadReadme(readmePath?: string): string {
  if (!readmePath) return '';

  try {
    const resolved = resolveFromCwd(readmePath);
    if (!fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const message = errorMessage(err);
    console.warn(`⚠️ Failed to read README at '${readmePath}': ${message}`);
    return '';
  }
}

export function loadPrompt(promptPath?: string): string {
  const resolvedPath = promptPath ? resolveFromCwd(promptPath) : undefined;

  if (resolvedPath && fs.existsSync(resolvedPath)) {
    return fs.readFileSync(resolvedPath, 'utf8');
  }

  const missing = resolvedPath ? `custom path '${promptPath}'` : 'no prompt path configured';
  console.warn(`⚠️ No AutoTriage prompt found (${missing}); using built-in label-only prompt.`);
  return BUILTIN_LABEL_ONLY_PROMPT;
}
