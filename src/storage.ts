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
    // eslint-disable-next-line no-console
    console.error(`⚠️ Failed to save artifact ${name} for #${issueNumber}: ${message}`);
  }
}

export function loadDatabase(dbPath?: string): TriageDb {
  if (!dbPath) return {};
  try {
    if (!fs.existsSync(dbPath)) return {};
    const contents = fs.readFileSync(dbPath, 'utf8');
    return contents ? JSON.parse(contents) : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`⚠️ Failed to load database: ${message}. Starting with empty database.`);
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
    // eslint-disable-next-line no-console
    console.error(`⚠️ Failed to save database: ${message}`);
  }
}

// Return prior reasoning log (older field alias supported for forward compatibility).
export function getPreviousReasoning(db: TriageDb, issueNumber: number): string {
  const entry = db[String(issueNumber)] as any;
  return (entry?.reasoning || entry?.reason || '') as string;
}

export function writeAnalysisToDb(
  db: TriageDb,
  issueNumber: number,
  analysis: AnalysisResult,
  fallbackTitle: string
): void {
  db[issueNumber] = {
    lastTriaged: new Date().toISOString(),
    reasoning: analysis.reasoning || 'no reasoning',
    summary: analysis.summary || (fallbackTitle || 'no summary'),
  } as any;
}

export type TriageDb = Record<string, {
  lastTriaged: string;
  // Full cumulative reasoning history (append-only log)
  reasoning: string;
  // Canonical issue summary for duplicate detection / clustering
  summary: string;
  labels?: string[];
}>;

export type Config = {
  owner: string;
  repo: string;
  token: string;
  geminiApiKey: string;
  modelTemperature: string;
  enabled: boolean;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  readmePath: string;
  dbPath?: string;
  modelFast: string;
  modelPro: string;
  maxTimelineEvents: number;
  maxOperations: number;
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

