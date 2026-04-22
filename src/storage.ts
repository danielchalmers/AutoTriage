import * as fs from 'fs';
import * as path from 'path';

export interface TriageDbEntry {
  lastTriaged?: string;   // ISO timestamp of when triage was completed
  summary?: string;       // One-line summary from analysis
}

export type TriageDb = Record<string, TriageDbEntry>;

export function loadDatabase(dbPath?: string): TriageDb {
  if (!dbPath) return {};

  try {
    if (!fs.existsSync(dbPath)) return {};

    const contents = fs.readFileSync(dbPath, 'utf8');
    const parsed = contents ? JSON.parse(contents) : {};
    const db = sanitizeDatabase(parsed);
    console.info(`📊 Loaded ${dbPath} with ${Object.keys(db).length} entries`);
    return db;
  } catch (err) {
    const message = getErrorMessage(err);
    console.error(`⚠️ Failed to load ${dbPath}: ${message}. Starting with empty database.`);
    return {};
  }
}

export function saveDatabase(db: TriageDb, dbPath?: string, dryRun?: boolean): void {
  if (!dbPath || dryRun) return;

  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(sanitizeDatabase(db), null, 2));
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
): void {
  const key = String(issueNumber);
  const existing = db[key] || {};
  const { thoughts: _thoughts, ...entry } = existing as TriageDbEntry & { thoughts?: string };

  entry.summary = summary;
  entry.lastTriaged = new Date().toISOString();

  db[key] = entry;
}

function sanitizeDatabase(db: unknown): TriageDb {
  if (!db || typeof db !== 'object') return {};

  return Object.fromEntries(
    Object.entries(db).map(([key, value]) => {
      const entry = value && typeof value === 'object' ? value as TriageDbEntry & { thoughts?: string } : {};
      const sanitizedEntry: TriageDbEntry = {
        ...(typeof entry.summary === 'string' ? { summary: entry.summary } : {}),
        ...(typeof entry.lastTriaged === 'string' ? { lastTriaged: entry.lastTriaged } : {}),
      };
      return [
        key,
        sanitizedEntry,
      ];
    })
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  dryRun: boolean;
  thinkingBudget: number;
  issueNumber?: number;
  issueNumbers?: number[];
  promptPath: string;
  readmePath: string;
  dbPath?: string;
  skipFastPass: boolean;
  modelFast: string;
  modelPro: string;
  maxFastTimelineEvents: number;
  maxProTimelineEvents: number;
  maxFastReadmeChars: number;
  maxProReadmeChars: number;
  maxFastIssueBodyChars: number;
  maxProIssueBodyChars: number;
  maxFastTimelineTextChars: number;
  maxProTimelineTextChars: number;
  maxProRuns: number;
  maxFastRuns: number;
  additionalInstructions?: string;
  contextCaching: boolean;
  extended: boolean;
  strictMode: boolean;
}
