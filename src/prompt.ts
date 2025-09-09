import * as fs from 'fs';
import * as path from 'path';
import { IssueLike, listTimelineEvents } from './github';
import { saveArtifact } from './storage';

export async function buildMetadata(issue: IssueLike) {
  return {
    title: issue.title,
    state: issue.state,
    type: issue.pull_request ? 'pull request' : 'issue',
    number: issue.number,
    author: issue.user?.login || 'unknown',
    user_type: issue.user?.type || 'unknown',
    draft: !!issue.draft,
    locked: !!issue.locked,
    milestone: issue.milestone?.title || null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at || null,
    comments: issue.comments || 0,
    reactions: issue.reactions?.total_count || 0,
    labels: (issue.labels || []).map(l => typeof l === 'string' ? l : (l.name || '')),
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map(a => a.login || '') : (issue.assignee ? [issue.assignee.login || ''] : []),
  };
}

export async function buildPrompt(
  octokit: any,
  owner: string,
  repo: string,
  issue: IssueLike,
  metadata: any,
  lastTriaged: string | null,
  previousReasoning: string,
  promptPath: string,
  maxTimelineEvents: number
) {
  const resolvedPath = path.isAbsolute(promptPath) ? promptPath : path.join(process.cwd(), promptPath);
  const basePrompt = fs.readFileSync(resolvedPath, 'utf8');
  const timelineReport = await listTimelineEvents(octokit, owner, repo, issue.number, maxTimelineEvents);
  const promptString = `${basePrompt}

=== SECTION: BODY OF ISSUE TO ANALYZE ===
${issue.body || ''}

=== SECTION: ISSUE METADATA (JSON) ===
${JSON.stringify(metadata, null, 2)}

=== SECTION: ISSUE TIMELINE (JSON) ===
${JSON.stringify(timelineReport, null, 2)}

=== SECTION: TRIAGE CONTEXT ===
Last triaged: ${lastTriaged || 'never'}
Previous reasoning: ${previousReasoning || 'none'}
Current date: ${new Date().toISOString()}. Do all date logic by explicit comparison.

=== SECTION: OUTPUT FORMAT ===
Core rules:
- Return only valid JSON (no Markdown fences, no prose).
- Only perform actions (labels, comments, edits, closing) when this prompt explicitly authorizes them and all action-specific preconditions are satisfied. 
- If the conditions for any action are ambiguous, incomplete, or not precisely met, do not act.
- Only include an optional field if the prompt explicitly authorizes the action
- Do not include fields with null values or empty strings
- Prefer first-person past-tense, include concise justifications, and keep entries compact but informative.

Required fields (always include):
- summary: string (stable description of the core problem for duplicate detection; include key symptoms, affected area, minimal repro hints, and environment/version if available; avoid volatile details like timestamps, usernames, or links unless essential)
- reasoning: string (full cumulative reasoning history; see rules below)
- labels: array of strings (complete final label set for the issue)

Reasoning history rules:
- Include the provided 'Previous reasoning' verbatim at the start of the reasoning string; keep the log append-only (never truncate).
- Append a compact first-person entry for this run (analysis + actions) and briefly self-debate whether you agree with the prior reasoning, citing concrete evidence from the body or timeline.
- If changing course, state the new evidence and why the prior view no longer holds; otherwise explain why it still holds.

Optional fields (include only when conditions are met):
- comment: string (comment to post on the issue)
- close: boolean (set to true to close the issue)  
- newTitle: string (new title for the issue)
`;

  saveArtifact(issue.number, 'gemini-input.md', promptString);
  return promptString;
}

