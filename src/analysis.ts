export type { PromptPassLimits, PromptPassMode } from './config';

export type AnalysisResult = {
  summary: string;
  operations: ModelOperation[];
};

export type ModelOperation =
  | { kind: 'add_labels'; labels: string[]; authorization: string }
  | { kind: 'remove_labels'; labels: string[]; authorization: string }
  | { kind: 'comment'; body: string; authorization: string }
  | { kind: 'set_state'; state: 'open' | 'completed' | 'not_planned'; authorization: string }
  | { kind: 'set_title'; title: string; authorization: string };

export type FastPassPlan = {
  analysis: AnalysisResult;
  operations: unknown[];
};

// Every operation shares the kind/payload/authorization skeleton. The payload must be spread rather
// than set through a computed key: a computed key collapses `properties` to an index signature and
// the label-schema tests lose the `in` narrowing they rely on.
function operationSchema<T extends object>(kinds: readonly string[], payload: T) {
  return {
    type: 'OBJECT',
    properties: { kind: { type: 'STRING', enum: kinds }, ...payload, authorization: { type: 'STRING' } },
    required: ['kind', ...Object.keys(payload), 'authorization'],
  };
}

function analysisResultSchema(labelItems: { type: 'STRING'; enum?: string[] }) {
  return {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      operations: {
        type: 'ARRAY',
        items: {
          anyOf: [
            operationSchema(['add_labels', 'remove_labels'], { labels: { type: 'ARRAY', items: labelItems } }),
            operationSchema(['comment'], { body: { type: 'STRING' } }),
            operationSchema(['set_state'], { state: { type: 'STRING', enum: ['open', 'completed', 'not_planned'] } }),
            operationSchema(['set_title'], { title: { type: 'STRING' } }),
          ],
        },
      },
    },
    required: ['summary', 'operations'],
  };
}

export const AnalysisResultSchema = analysisResultSchema({ type: 'STRING' });

export type RepoLabel = { name: string; description?: string | null };

export function normalizeRepoLabels<T extends { name: string; description?: string | null }>(repoLabels: T[]): T[] {
  return [...repoLabels].sort((a, b) => {
    const nameOrder = a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    if (nameOrder !== 0) return nameOrder;
    return (a.description ?? '').localeCompare(b.description ?? '', 'en', { sensitivity: 'base' });
  });
}

/**
 * Build a schema that constrains label values to actual repository labels.
 * This ensures the AI returns labels in the exact format they exist in the repository,
 * preventing issues like "breaking change" being converted to "breaking_change".
 */
export function buildAnalysisResultSchema(repoLabels: Array<{ name: string }>) {
  // If no repository labels are available, fall back to unconstrained schema
  if (repoLabels.length === 0) {
    return AnalysisResultSchema;
  }

  return analysisResultSchema({ type: 'STRING', enum: normalizeRepoLabels(repoLabels).map(l => l.name) });
}

export { buildSystemPrompt, buildUserPrompt } from './prompts';
