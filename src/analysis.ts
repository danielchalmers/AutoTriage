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

/**
 * Narrow the model's parsed reply to the AnalysisResult shape.
 * A reply that isn't an object with an operations array throws, so the model call retries it like a parse error.
 * A non-string summary becomes '' so callers fall back to the issue title; each operation is still checked by planOperations.
 */
export function parseAnalysisResult(data: unknown): AnalysisResult {
  const reply = data !== null && typeof data === 'object' ? data as { summary?: unknown; operations?: unknown } : {};
  if (!Array.isArray(reply.operations)) {
    throw new Error('Model reply is not an object with an operations array');
  }
  return { ...reply, summary: typeof reply.summary === 'string' ? reply.summary : '', operations: reply.operations };
}

// Every operation shares the kind/payload/authorization skeleton, as strict JSON Schema: every property required and no others allowed.
// The payload must be spread rather than set through a computed key: a computed key collapses `properties` to an index signature and the label-schema tests lose the `in` narrowing they rely on.
function operationSchema<T extends object>(kinds: readonly string[], payload: T) {
  return {
    type: 'object',
    properties: { kind: { type: 'string', enum: kinds }, ...payload, authorization: { type: 'string' } },
    required: ['kind', ...Object.keys(payload), 'authorization'],
    additionalProperties: false,
  };
}

function analysisResultSchema(labelItems: { type: 'string'; enum?: string[] }) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      operations: {
        type: 'array',
        items: {
          anyOf: [
            operationSchema(['add_labels', 'remove_labels'], { labels: { type: 'array', items: labelItems } }),
            operationSchema(['comment'], { body: { type: 'string' } }),
            operationSchema(['set_state'], { state: { type: 'string', enum: ['open', 'completed', 'not_planned'] } }),
            operationSchema(['set_title'], { title: { type: 'string' } }),
          ],
        },
      },
    },
    required: ['summary', 'operations'],
    additionalProperties: false,
  };
}

export const AnalysisResultSchema = analysisResultSchema({ type: 'string' });

// OpenAI caps enums at 250 values before it also limits their total length, and unknown labels are dropped when the plan is applied anyway.
const MAX_LABEL_ENUM = 250;

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
 * This ensures the AI returns labels in the exact format they exist in the repository, preventing issues like "breaking change" being converted to "breaking_change".
 */
export function buildAnalysisResultSchema(repoLabels: Array<{ name: string }>) {
  if (repoLabels.length === 0 || repoLabels.length > MAX_LABEL_ENUM) {
    return AnalysisResultSchema;
  }

  return analysisResultSchema({ type: 'string', enum: normalizeRepoLabels(repoLabels).map(l => l.name) });
}

export { buildSystemPrompt, buildUserPrompt } from './prompts';
