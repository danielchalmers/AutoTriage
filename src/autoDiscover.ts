import { Issue } from './github';
import { TriageDb, TriageDbEntry, getDbEntry } from './storage';

// Orders auto-discover targets so anything new or updated since our last triage is processed first.
// If skipUnchanged is true, issues that are already in the database and haven't changed are excluded.
export function buildAutoDiscoverQueue(issues: Issue[], db: TriageDb, skipUnchanged: boolean = false): number[] {
  if (!issues || issues.length === 0) return [];

  const prioritized: number[] = [];
  const secondary: Array<{ number: number; lastTriagedMs: number }> = [];

  for (const issue of issues) {
    const lastUpdatedMs = getLastUpdatedMs(issue);
    const entry = getDbEntry(db, issue.number);
    const needsAttention = shouldPrioritize(lastUpdatedMs, entry);
    if (needsAttention) {
      // Preserve GitHub's recency order inside prioritized bucket to keep cycling smoothly.
      prioritized.push(issue.number);
    } else {
      // Skip unchanged issues if requested
      if (skipUnchanged) continue;
      
      // Track lastTriaged timestamp for sorting secondary bucket
      // safeParseDate returns 0 for missing/undefined values, sorting them first
      const lastTriagedMs = safeParseDate(entry?.lastTriaged);
      secondary.push({ number: issue.number, lastTriagedMs });
    }
  }

  // Sort secondary by lastTriaged (oldest first)
  secondary.sort((a, b) => a.lastTriagedMs - b.lastTriagedMs);

  return prioritized.concat(secondary.map(item => item.number));
}

// During backlog auto-discovery, include recently updated closed issues only when we've triaged them before.
export function filterPreviouslyTriagedClosedIssuesWithNewActivity(issues: Issue[], db: TriageDb): Issue[] {
  return (issues || []).filter(issue => {
    const entry = getDbEntry(db, issue.number);
    const triagedMs = safeParseDate(entry?.lastTriaged);
    if (triagedMs === 0) return false; // Never triaged before (or invalid timestamp)
    const closedMs = safeParseDate(issue.closed_at);
    const updatedMs = getLastUpdatedMs(issue);
    const baselineMs = Math.max(triagedMs, closedMs);
    return updatedMs > baselineMs;
  });
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
