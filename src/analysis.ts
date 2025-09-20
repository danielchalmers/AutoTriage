import { saveArtifact } from './storage';
import { buildPrompt } from './prompt';
import type { Issue, TimelineEvent } from './github';
import type { Config } from './storage';
import { GeminiClient } from './gemini';

export type AnalysisResult = {
  summary: string;
  reasoning: string;
  labels?: string[];
  comment?: string;
  state?: 'open' | 'completed' | 'not_planned';
  newTitle?: string;
};

export async function generateAnalysis(
  cfg: Config,
  gemini: GeminiClient,
  issue: Issue,
  lastTriaged: Date | null,
  previousReasoning: string,
  model: string,
  timelineEvents: TimelineEvent[],
  repoLabels?: Array<{ name: string; description?: string | null }>
): Promise<AnalysisResult> {
  const { systemPrompt, userPrompt } = await buildPrompt(
    issue,
    lastTriaged,
    previousReasoning,
    cfg.promptPath,
    cfg.readmePath,
    timelineEvents,
    repoLabels
  );

  saveArtifact(issue.number, `input-system.md`, systemPrompt);
  saveArtifact(issue.number, `input-user-${model}.md`, userPrompt);

  const schema = {
    type: 'OBJECT',
    properties: {
      summary: { type: 'STRING' },
      reasoning: { type: 'STRING' },
      comment: { type: 'STRING' },
      labels: { type: 'ARRAY', items: { type: 'STRING' } },
      state: { type: 'STRING', enum: ['open', 'completed', 'not_planned'] },
      newTitle: { type: 'STRING' },
    },
    required: ['summary', 'reasoning', 'labels'],
  } as const;

  const result = await gemini.generateJson<AnalysisResult>(
    model,
    systemPrompt,
    userPrompt,
    schema,
    cfg.modelTemperature,
    2,
    15000
  );
  saveArtifact(issue.number, `analysis-${model}.json`, JSON.stringify(result, null, 2));
  return result;
}

