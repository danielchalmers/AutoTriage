import * as fs from 'fs';
import * as path from 'path';

export interface TriageDbEntry {
  lastTriaged?: string;   // ISO timestamp of when triage was completed
  thoughts?: string;      // Raw model "thoughts" / chain-of-thought output
  summary?: string;       // One-line summary from analysis
}

export type TriageDb = Record<string, TriageDbEntry>;

export function loadDatabase(dbPath?: string): TriageDb {
  if (!dbPath) return {};

  try {
    if (!fs.existsSync(dbPath)) return {};

    const contents = fs.readFileSync(dbPath, 'utf8');
    const db = contents ? JSON.parse(contents) : {};
    console.info(`📊 Loaded ${dbPath} with ${Object.keys(db).length} entries`);
    return db;
  } catch (err) {
    const message = getErrorMessage(err);
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
    const message = getErrorMessage(err);
    console.error(`⚠️ Failed to save ${dbPath}: ${message}`);
  }
}

export function getDbEntry(db: TriageDb, issueNumber: number): TriageDbEntry {
  return db[String(issueNumber)] || {};
}

export function updateDbEntry(
  db: TriageDb,
  issueNumber: number,
  summary: string,
  thoughts: string
): void {
  const key = String(issueNumber);
  const existing = db[key] || {};
  const entry: TriageDbEntry = { ...existing };

  entry.summary = summary;
  entry.thoughts = thoughts;
  entry.lastTriaged = new Date().toISOString();

  db[key] = entry;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function saveArtifact(issueNumber: number, name: string, contents: string): void {
  try {
    const artifactsDir = path.join(process.cwd(), 'artifacts');
    const fileName = `${issueNumber}-${name}`;
    const filePath = path.join(artifactsDir, fileName);

    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
  } catch (err) {
    const message = getErrorMessage(err);
    console.error(`⚠️ Failed to save artifact ${name} for #${issueNumber}: ${message}`);
  }
}

export function loadReadme(readmePath?: string): string {
  if (!readmePath) return '';

  try {
    const resolved = path.isAbsolute(readmePath)
      ? readmePath
      : path.join(process.cwd(), readmePath);

    if (!fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    const message = getErrorMessage(err);
    console.warn(`⚠️ Failed to read README at '${readmePath}': ${message}`);
    return '';
  }
}

export function loadPrompt(promptPath?: string): string {
  const loadBundledPrompt = () => {
    const bundledPath = path.join(__dirname, 'AutoTriage.prompt');
    return fs.readFileSync(bundledPath, 'utf8');
  };

  if (!promptPath) {
    try {
      return loadBundledPrompt();
    } catch (bundledError) {
      const bundledMessage = getErrorMessage(bundledError);
      throw new Error(`Failed to load prompt. Bundled fallback: ${bundledMessage}`);
    }
  }

  try {
    // Try custom prompt path first
    const resolvedPath = path.isAbsolute(promptPath)
      ? promptPath
      : path.join(process.cwd(), promptPath);
    return fs.readFileSync(resolvedPath, 'utf8');
  } catch (error) {
    // Fall back to bundled default prompt
    try {
      return loadBundledPrompt();
    } catch (bundledError) {
      const customMessage = getErrorMessage(error);
      const bundledMessage = getErrorMessage(bundledError);
      throw new Error(
        `Failed to load prompt. Custom path '${promptPath}': ${customMessage}. ` +
        `Bundled fallback: ${bundledMessage}`
      );
    }
  }
}

export interface Config {
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
  skipFastPass: boolean;
  modelFast: string;
  modelPro: string;
  maxTimelineEvents: number;
  maxTriages: number;
  maxFastRuns: number;
  additionalInstructions?: string;
  skipUnchanged: boolean;
}
