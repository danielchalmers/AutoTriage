import { AnalysisResult, Config } from './types';
import { diffLabels } from './labels';
import { TriageOperation, UpdateLabelsOp, CreateCommentOp, UpdateTitleOp, CloseIssueOp } from './operations';

function filterLabels(labels: string[] | undefined, repoLabels: string[] | undefined): string[] | undefined {
  if (!labels || labels.length === 0) return labels;
  if (!repoLabels || repoLabels.length === 0) return labels;
  const allowed = new Set(repoLabels);
  return labels.filter(l => allowed.has(l));
}

export function planOperations(
  cfg: Config,
  issue: any,
  analysis: AnalysisResult,
  metadata: any,
  repoLabels?: string[]
): TriageOperation[] {
  const ops: TriageOperation[] = [];

  // Labels
  if (Array.isArray(analysis.labels)) {
    const filtered = filterLabels(analysis.labels, repoLabels) || [];
    const current = Array.isArray(metadata.labels) ? (metadata.labels as string[]) : [];
    const { toAdd, toRemove, merged } = diffLabels(current, filtered);
    if (toAdd.length || toRemove.length) ops.push(new UpdateLabelsOp(toAdd, toRemove, merged));
  }

  // Comment
  if (typeof analysis.comment === 'string' && analysis.comment.trim().length > 0) {
    const body = `<!-- ${analysis.reasoning || 'No reasoning provided'} -->\n\n${analysis.comment}`;
    ops.push(new CreateCommentOp(body));
  }

  // Title change
  if (analysis.newTitle && analysis.newTitle.trim() && analysis.newTitle !== issue.title) {
    ops.push(new UpdateTitleOp(analysis.newTitle));
  }

  // Close
  if (analysis.close === true) {
    ops.push(new CloseIssueOp());
  }

  return ops;
}
