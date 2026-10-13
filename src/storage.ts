import * as fs from 'fs';
import * as path from 'path';
import { errorMessage } from './llm/chat';

// When each item was last triaged, and the updated_at it had then, so a later run can tell whether it changed.
export interface TriageDbEntry {
  lastTriaged?: string;
  lastSeenUpdatedAt?: string;
}

export interface TriageDb {
  version: 2;
  items: Record<string, TriageDbEntry>;
}

function createEmptyDatabase(): TriageDb {
  return { version: 2, items: {} };
}

export function loadDatabase(dbPath?: string): TriageDb {
  if (!dbPath) return createEmptyDatabase();

  try {
    if (!fs.existsSync(dbPath)) return createEmptyDatabase();

    const contents = fs.readFileSync(dbPath, 'utf8');
    const db = readDatabase(contents ? JSON.parse(contents) : undefined);
    console.info(`📊 Loaded ${dbPath} with ${Object.keys(db.items).length} entries`);
    return db;
  } catch (err) {
    const message = errorMessage(err);
    console.error(`⚠️ Failed to load ${dbPath}: ${message}. Starting with empty database.`);
    return createEmptyDatabase();
  }
}

// Keeps only the fields AutoTriage reads, and starts empty from anything that isn't a version 2 database.
function readDatabase(value: unknown): TriageDb {
  const db = createEmptyDatabase();
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.items)) return db;
  for (const [key, raw] of Object.entries(value.items)) {
    if (!isRecord(raw)) continue;
    const entry: TriageDbEntry = {};
    if (typeof raw.lastTriaged === 'string') entry.lastTriaged = raw.lastTriaged;
    if (typeof raw.lastSeenUpdatedAt === 'string') entry.lastSeenUpdatedAt = raw.lastSeenUpdatedAt;
    if (Object.keys(entry).length > 0) db.items[key] = entry;
  }
  return db;
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

export function updateDbEntry(db: TriageDb, issueNumber: number, lastSeenUpdatedAt: string | undefined): void {
  const key = String(issueNumber);
  db.items[key] = { ...db.items[key], lastTriaged: new Date().toISOString(), ...(lastSeenUpdatedAt ? { lastSeenUpdatedAt } : {}) };
}

function isRecord(value: unknown): value is Record<string, any> {
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

function resolveFromCwd(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

// A file's text from the workspace, or undefined when the job didn't check it out.
export function readWorkspaceFile(filePath: string): string | undefined {
  const resolved = resolveFromCwd(filePath);
  return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? fs.readFileSync(resolved, 'utf8') : undefined;
}
