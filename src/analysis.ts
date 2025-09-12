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

/**
 * Run a single model pass (fast or pro) returning the structured triage analysis.
 * Throws when the Gemini model invocation fails so callers can decide whether to
 * propagate or swallow the error.
 */
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
  const res = await gemini.generate(prompt, model, cfg.modelTemperature, issue.number);
  saveArtifact(issue.number, `analysis-${model}.json`, JSON.stringify(res, null, 2));
  return res;
}

