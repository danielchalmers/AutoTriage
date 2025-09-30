import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisResult } from "./analysis";

// Best-effort write; failures are non-fatal and only logged to stderr.
export function saveArtifact(issueNumber: number, name: string, contents = ''): void {
  try {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    const filePath = path.join(artifactsDir, `${issueNumber}-${name}`);
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ Failed to save artifact ${name} for #${issueNumber}: ${message}`);
  }
}

export function loadDatabase(dbPath?: string): TriageDb {
  if (!dbPath) return {};
  try {
    if (!fs.existsSync(dbPath)) return {};
    const contents = fs.readFileSync(dbPath, 'utf8');
    const db = contents ? JSON.parse(contents) : {};
    console.info(`📊 Loaded ${dbPath} with ${Object.keys(db).length} entries`);
    return db;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ Failed to load ${dbPath}: ${message}. Starting with empty database.`);
    return {};
  }
}

export function saveDatabase(db: TriageDb, dbPath?: string, enabled?: boolean): void {
  if (!dbPath || !enabled) return;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`⚠️ Failed to save ${dbPath}: ${message}`);
  }
}

export type TriageDb = Record<string, TriageDbEntry>;

export interface TriageDbEntry {
  lastTriaged?: string;
  thoughts?: string;
  summary?: string;
}

export function getDbEntry(db: TriageDb, issueNumber: number): TriageDbEntry {
  return db[String(issueNumber)] || {};
}

export function updateDbEntry(
  db: TriageDb,
  issueNumber: number,
  summary: string,
  thoughts: string,
): void {
  const key = String(issueNumber);
  const existing: TriageDbEntry | undefined = db[key];
  const entry: TriageDbEntry = {
    ...existing,
    summary,
    thoughts,
    lastTriaged: new Date().toISOString(),
  };
  db[key] = entry;
}

export type Config = {
  owner: string;
  repo: string;
  token: string;
  geminiApiKey: string;
  modelTemperature: number;
  enabled: boolean;
  thinkingBudget: number;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  readmePath: string;
  dbPath?: string;
  modelFast: string;
  modelPro: string;
  maxTimelineEvents: number;
  maxTriages: number;
};

export function loadReadme(readmePath?: string): string {
  if (!readmePath) return '';
  try {
    const resolved = path.isAbsolute(readmePath) ? readmePath : path.join(process.cwd(), readmePath);
    if (!fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: failed to read README at '${readmePath}': ${message}`);
    return '';
  }
}

export function loadPrompt(promptPath: string): string {
  try {
    // If a prompt path is provided, try to load it
    const resolvedPath = path.isAbsolute(promptPath) ? promptPath : path.join(process.cwd(), promptPath);
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    // If custom prompt file doesn't exist, fall through to bundled default
    const bundledPath = path.join(__dirname, 'AutoTriage.prompt');
    return fs.readFileSync(bundledPath, 'utf8');
  }
}
