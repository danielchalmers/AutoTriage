import { Issue } from './github';
import { TriageDb, TriageDbEntry, getDbEntry } from './storage';

// Orders auto-discover targets so anything new or updated since our last triage is processed first.
export function buildAutoDiscoverQueue(issues: Issue[], db: TriageDb): number[] {
  if (!issues || issues.length === 0) return [];

  const prioritized: number[] = [];
  const secondary: number[] = [];

  for (const issue of issues) {
    const lastUpdatedMs = getLastUpdatedMs(issue);
    const entry = getDbEntry(db, issue.number);
    const needsAttention = shouldPrioritize(lastUpdatedMs, entry);
    // Preserve GitHub's recency order inside each bucket to keep cycling smoothly.
    const bucket = needsAttention ? prioritized : secondary;
    bucket.push(issue.number);
  }

  return prioritized.concat(secondary);
}

function getLastUpdatedMs(issue: Issue): number {
  return safeParseDate(issue.updated_at) || safeParseDate(issue.created_at);
}

function shouldPrioritize(lastUpdatedMs: number, entry?: TriageDbEntry): boolean {
  if (!entry?.lastTriaged) return true;
  const triagedMs = safeParseDate(entry.lastTriaged);
  if (triagedMs === 0) return true;
  if (lastUpdatedMs === 0) return false;
  return lastUpdatedMs > triagedMs;
}

function safeParseDate(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
