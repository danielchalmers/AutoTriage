import * as fs from 'fs';
import * as path from 'path';
import { IssueLike, listTimelineEvents } from './github';
import { saveArtifact } from './artifacts';

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
Current date: ${new Date().toISOString()}. Do all date logic by explicit comparison to the provided "Current date" timestamp (no vague relative wording).

=== SECTION: OUTPUT FORMAT ===
Return only valid JSON (no Markdown fences, no prose).

Only perform actions (labels, comments, edits, closing) when this prompt explicitly authorizes them and all action-specific preconditions are satisfied. 
Do not take subjective or discretionary actions (for example: "this looks resolved", "seems low-priority", or "apply label because maintainer implied it"). 
Never act based on your own interpretation or summary of maintainer comments - maintainer statements are not instructions unless they explicitly direct the bot. 
If the conditions for any action are ambiguous, incomplete, or not precisely met, do not act.

Required fields (always include):
- summary: string (one canonical, stable description of the core problem for duplicate detection; include key symptoms, affected area, minimal repro hints, and environment/version if available; avoid volatile details like timestamps, usernames, or links unless essential)
- reasoning: string (full cumulative reasoning history; see rules below)
- labels: array of strings (complete final label set for the issue)

Reasoning history rules:
- Treat the provided "Previous reasoning" as the prior log; include it verbatim at the start of the reasoning string.
- Append a new single-line or short-paragraph entry for this triage run describing your analysis and actions, e.g., "I wrote a comment to ask for more information and added the 'info required' label, but a user has now provided that information so I will remove the label".
- Prefer first-person past-tense, include concise justifications, and keep entries compact but informative.
- This history is allowed to keep growing across runs; do not truncate prior content.

Optional fields (include only when conditions are met):
- comment: string (comment to post on the issue)
- close: boolean (set to true to close the issue)  
- newTitle: string (new title for the issue)

Inclusion rules for optional fields:
- Only include an optional field if the prompt explicitly authorizes the action
- Do not include fields with null values or empty strings
`;

  saveArtifact(issue.number, 'gemini-input.md', promptString);
  return promptString;
}

