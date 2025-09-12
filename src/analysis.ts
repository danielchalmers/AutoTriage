import { saveArtifact } from './storage';
import { buildPrompt } from './prompt';
import type { IssueLike } from './github';
import type { Config } from './storage';
import type { GeminiClient } from './gemini';

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
  issue: IssueLike,
  metadata: any,
  lastTriaged: string | null,
  previousReasoning: string,
  model: string,
  timelineEvents: any[]
): Promise<AnalysisResult> {
  const prompt = await buildPrompt(
    issue,
    metadata,
    lastTriaged,
    previousReasoning,
    cfg.promptPath,
    timelineEvents
  );

  saveArtifact(issue.number, `gemini-input-${model}.md`, prompt);
  const result = await gemini.generate(prompt, model, cfg.modelTemperature, issue.number);
  saveArtifact(issue.number, `analysis-${model}.json`, JSON.stringify(result, null, 2));
  return result;
}

