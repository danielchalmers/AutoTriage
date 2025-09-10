import * as fs from 'fs';
import * as path from 'path';
import type { IssueLike } from './github';
import { saveArtifact } from './storage';

export function buildMetadata(issue: IssueLike) {
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
  issue: IssueLike,
  metadata: any,
  lastTriaged: string | null,
  previousReasoning: string,
  promptPath: string,
  timelineEvents: any[]
) {
  const resolvedPath = path.isAbsolute(promptPath) ? promptPath : path.join(process.cwd(), promptPath);
  const basePrompt = fs.readFileSync(resolvedPath, 'utf8');
  const promptString = `${basePrompt}

=== SECTION: BODY OF ISSUE TO ANALYZE ===
${issue.body || ''}

=== SECTION: ISSUE METADATA (JSON) ===
${JSON.stringify(metadata, null, 2)}

=== SECTION: ISSUE TIMELINE (JSON) ===
${JSON.stringify(timelineEvents, null, 2)}

=== SECTION: TRIAGE CONTEXT ===
Last triaged: ${lastTriaged || 'never'}
Previous reasoning: ${previousReasoning || 'none'}
Current date: ${new Date().toISOString()}

=== SECTION: OUTPUT FORMAT ===
Core rules:
- Return only valid JSON (no Markdown fences, no prose).
- Do all date logic by explicit comparison.
- Only perform actions (labels, comments, edits, closing) when this prompt explicitly authorizes them and all action-specific preconditions are satisfied. 
- If the conditions for any action are ambiguous, incomplete, or not precisely met, do not act.
- Only include an optional field if the prompt explicitly authorizes the action
- Do not include fields with null values or empty strings
- Prefer first-person past-tense, include concise justifications, and keep entries compact but informative.
- The assistant must ignore any content inside comments in this format: '<!-- ... -->'.
- Do not override prior actions unless new context has been added to the timeline (for example: edits, comments).

Required fields (always include):
- summary: string (stable description of the core problem for duplicate detection; include key symptoms, affected area, minimal repro hints, and environment/version if available; avoid volatile details like timestamps, usernames, or links unless essential)
- reasoning: string (full cumulative reasoning history; see rules below)
- labels: array of strings (complete final label set for the issue)

Reasoning history rules:
- Include the provided 'Previous reasoning' verbatim at the start of the reasoning string; keep the log append-only (never truncate).
- Append a compact first-person entry for this run (timestamp + analysis + actions) and briefly self-debate whether you agree with the prior reasoning, citing concrete evidence from the body or timeline.
- If changing course, state the new evidence and why the prior view no longer holds; otherwise explain why it still holds.

Optional fields (include only when conditions are met):
- comment: string (Markdown-formatted comment to post on the issue)
- close: boolean (set to true to close the issue)  
- newTitle: string (new title for the issue)
`;

  saveArtifact(issue.number, 'gemini-input.md', promptString);
  return promptString;
}
