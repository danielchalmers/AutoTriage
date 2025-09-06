import { ActionPlan, AnalysisResult, Config } from './types';
import { diffLabels } from './labels';

function filterLabels(labels: string[] | undefined, allowlist?: string[]): string[] | undefined {
  if (!labels || labels.length === 0) return labels;
  if (!allowlist || allowlist.length === 0) return labels;
  const allowed = new Set(allowlist);
  return labels.filter(l => allowed.has(l));
}

export function buildActionPlan(
  cfg: Config,
  issue: any,
  analysis: AnalysisResult,
  metadata: any
): [ActionPlan, boolean] {
  let hasActions = false;
  const plan: ActionPlan = {};

  // Labels
  if (Array.isArray(analysis.labels)) {
    const filtered = filterLabels(analysis.labels, cfg.labelAllowlist) || [];
    const current = Array.isArray(metadata.labels) ? (metadata.labels as string[]) : [];
    const { toAdd, toRemove, merged } = diffLabels(current, filtered);
    if (toAdd.length || toRemove.length) {
      plan.labels = { toAdd, toRemove, merged };
      hasActions = true;
    }
  }

  // Comment
  if (typeof analysis.comment === 'string' && analysis.comment.trim().length > 0) {
    const body = `<!-- ${analysis.reason || 'No reasoning provided'} -->\n\n${analysis.comment}`;
    plan.commentBody = body;
    hasActions = true;
  }

  // Title change
  if (analysis.newTitle && analysis.newTitle.trim() && analysis.newTitle !== issue.title) {
    plan.newTitle = analysis.newTitle;
    hasActions = true;
  }

  // Close
  if (analysis.close === true) {
    plan.close = true;
    hasActions = true;
  }

  return [plan, hasActions];
}
