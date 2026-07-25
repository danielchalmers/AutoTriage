import type { Config } from './config';

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

const LabelOperationSchema = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['add_labels', 'remove_labels'] },
    labels: { type: 'ARRAY', items: { type: 'STRING' } },
    authorization: { type: 'STRING' },
  },
  required: ['kind', 'labels', 'authorization'],
} as const;

const CommentOperationSchema = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['comment'] },
    body: { type: 'STRING' },
    authorization: { type: 'STRING' },
  },
  required: ['kind', 'body', 'authorization'],
} as const;

const SetStateOperationSchema = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['set_state'] },
    state: { type: 'STRING', enum: ['open', 'completed', 'not_planned'] },
    authorization: { type: 'STRING' },
  },
  required: ['kind', 'state', 'authorization'],
} as const;

const SetTitleOperationSchema = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['set_title'] },
    title: { type: 'STRING' },
    authorization: { type: 'STRING' },
  },
  required: ['kind', 'title', 'authorization'],
} as const;

export const AnalysisResultSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    operations: {
      type: 'ARRAY',
      items: {
        anyOf: [
          LabelOperationSchema,
          CommentOperationSchema,
          SetStateOperationSchema,
          SetTitleOperationSchema,
        ],
      },
    },
  },
  required: ['summary', 'operations'],
} as const;

export type PromptPassMode = 'fast' | 'pro';

export type PromptPassLimits = {
  readmeChars: number;
  issueBodyChars: number;
  timelineEvents: number;
  timelineTextChars: number;
};

export type RepoLabel = { name: string; description?: string | null };

export function getPromptLimits(config: Config, mode: PromptPassMode): PromptPassLimits {
  if (mode === 'fast') {
    return {
      readmeChars: config.maxFastReadmeChars,
      issueBodyChars: config.maxFastIssueBodyChars,
      timelineEvents: config.maxFastTimelineEvents,
      timelineTextChars: config.maxFastTimelineTextChars,
    };
  }
  return {
    readmeChars: config.maxProReadmeChars,
    issueBodyChars: config.maxProIssueBodyChars,
    timelineEvents: config.maxProTimelineEvents,
    timelineTextChars: config.maxProTimelineTextChars,
  };
}

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
  
  const labelNames = normalizeRepoLabels(repoLabels).map(l => l.name);
  const labelOperationSchema = {
    ...LabelOperationSchema,
    properties: {
      ...LabelOperationSchema.properties,
      labels: {
        type: 'ARRAY' as const,
        items: {
          type: 'STRING' as const,
          enum: labelNames,
        },
      },
    },
  };
  
  return {
    ...AnalysisResultSchema,
    properties: {
      ...AnalysisResultSchema.properties,
      operations: {
        ...AnalysisResultSchema.properties.operations,
        items: {
          anyOf: [
            labelOperationSchema,
            CommentOperationSchema,
            SetStateOperationSchema,
            SetTitleOperationSchema,
          ],
        },
      },
    },
  };
}

export { buildSystemPrompt, buildUserPrompt } from './prompts';
