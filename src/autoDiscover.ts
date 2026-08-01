import { Issue } from './github';
import { TriageDb, TriageDbEntry, getDbEntry } from './storage';
import { parseTimestamp } from './util';

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
      if (skipUnchanged) continue;

      // parseTimestamp returns 0 for missing values, which sorts never-triaged items first.
      const lastTriagedMs = parseTimestamp(entry?.lastTriaged);
      secondary.push({ number: issue.number, lastTriagedMs });
    }
  }

  secondary.sort((a, b) => a.lastTriagedMs - b.lastTriagedMs);

  return prioritized.concat(secondary.map(item => item.number));
}

// During backlog auto-discovery, include recently updated closed issues only when we've triaged them before.
export function filterPreviouslyTriagedClosedIssuesWithNewActivity(issues: Issue[], db: TriageDb): Issue[] {
  return (issues || []).filter(issue => {
    const entry = getDbEntry(db, issue.number);
    const triagedMs = parseTimestamp(entry?.lastTriaged);
    if (triagedMs === 0) return false; // Never triaged before (or invalid timestamp)
    const closedMs = parseTimestamp(issue.closed_at);
    const updatedMs = getLastUpdatedMs(issue);
    const baselineMs = Math.max(getActivityBaselineMs(entry), closedMs);
    return updatedMs > baselineMs;
  });
}

function getLastUpdatedMs(issue: Issue): number {
  return parseTimestamp(issue.updated_at) || parseTimestamp(issue.created_at);
}

function shouldPrioritize(lastUpdatedMs: number, entry?: TriageDbEntry): boolean {
  if (!entry?.lastTriaged) return true;
  const baselineMs = getActivityBaselineMs(entry);
  if (baselineMs === 0) return true;
  if (lastUpdatedMs === 0) return false;
  return lastUpdatedMs > baselineMs;
}

function getActivityBaselineMs(entry?: TriageDbEntry): number {
  return parseTimestamp(entry?.lastSeenUpdatedAt ?? entry?.lastTriaged);
}
