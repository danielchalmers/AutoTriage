import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from './llm/chat';

// The triage history always lives in this file in the working directory, where a workflow's cache step restores and saves it.
export const DB_FILE = 'triage-db.json';

export interface TriageDbEntry {
  lastTriaged?: string;   // ISO timestamp of when triage was completed
  lastSeenUpdatedAt?: string; // GitHub updated_at watermark already consumed
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

function dbPath(): string {
  return path.join(process.cwd(), DB_FILE);
}

// Loads the triage history if the working directory has one, and otherwise starts empty, so every item counts as new.
export function loadDatabase(): TriageDb {
  const file = dbPath();
  try {
    if (!fs.existsSync(file)) return createEmptyDatabase();

    const contents = fs.readFileSync(file, 'utf8');
    if (!contents) return createEmptyDatabase();
    const parsed: unknown = JSON.parse(contents);
    if (!isV2Database(parsed)) {
      console.warn(`⚠️ ${DB_FILE} isn't a version 2 triage database, so it's ignored and every item counts as new.`);
      return createEmptyDatabase();
    }
    const db = normalizeV2Database(parsed);
    console.info(`📊 Loaded ${DB_FILE} with ${Object.keys(db.items).length} entries`);
    return db;
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to load ${DB_FILE}: ${message}. Starting with empty database.`);
    return createEmptyDatabase();
  }
}

export function saveDatabase(db: TriageDb, dryRun: boolean): void {
  if (dryRun) return;

  try {
    fs.writeFileSync(dbPath(), JSON.stringify(db, null, 2));
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to save ${DB_FILE}: ${message}`);
  }
}

export function getDbEntry(db: TriageDb, issueNumber: number): TriageDbEntry {
  return db.items[String(issueNumber)] || {};
}

// Records that the item was triaged now, and the GitHub updated_at it consumed, keeping the previous watermark when there is none.
export function updateDbEntry(db: TriageDb, issueNumber: number, lastSeenUpdatedAt?: string): void {
  const key = String(issueNumber);
  const entry: TriageDbEntry = { ...db.items[key], lastTriaged: new Date().toISOString() };
  if (lastSeenUpdatedAt) {
    entry.lastSeenUpdatedAt = lastSeenUpdatedAt;
  }

  db.items[key] = entry;
}

function isV2Database(value: unknown): value is TriageDb {
  return isRecord(value) && value.version === 2 && isRecord(value.items);
}

// Keeps only the recognized fields, such as dropping the summary that earlier versions wrote, and only the entries that have one.
function normalizeV2Database(db: TriageDb): TriageDb {
  const items: Record<string, TriageDbEntry> = {};
  for (const [key, value] of Object.entries(db.items)) {
    if (!isRecord(value)) continue;
    const entry: TriageDbEntry = {};
    if (typeof value.lastTriaged === 'string') entry.lastTriaged = value.lastTriaged;
    if (typeof value.lastSeenUpdatedAt === 'string') entry.lastSeenUpdatedAt = value.lastSeenUpdatedAt;
    if (Object.keys(entry).length > 0) items[key] = entry;
  }
  return { version: 2, items };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Per-item artifacts are prefixed with the item number.
export function saveArtifact(issueNumber: number, name: string, contents: string): void {
  writeArtifact(`${issueNumber}-${name}`, contents);
}

// Run-level artifacts, such as the system prompts and run-summary.json, keep their bare names.
export function saveRunArtifact(name: string, contents: string): void {
  writeArtifact(name, contents);
}

function writeArtifact(fileName: string, contents: string): void {
  try {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(path.join(artifactsDir, fileName), contents, 'utf8');
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to save artifact ${fileName}: ${message}`);
  }
}
