import * as core from '@actions/core';
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
  status?: 'close_not_planned' | 'close_completed' | 'reopen';
  newTitle?: string;
};

/**
 * Run a single model pass (fast or pro) returning the structured triage analysis.
 * Never throws for model logic errors; returns null if the model call or parse fails.
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
): Promise<AnalysisResult | null> {
  const prompt = await buildPrompt(
    issue,
    metadata,
    lastTriaged,
    previousReasoning,
    cfg.promptPath,
  timelineEvents
  );

  saveArtifact(issue.number, `gemini-input-${model}.md`, prompt);
  let analysis: AnalysisResult | null = null;
  try {
    const res = await gemini.generate(prompt, model, cfg.modelTemperature, issue.number);
    saveArtifact(issue.number, `analysis-${model}.json`, JSON.stringify(res, null, 2));
    core.info(`🤖 ${model} #${issue.number}:`);
    core.info(`  💭 ${(res as any).summary ?? ''}`);
    core.info(`  💭 ${(res as any).reasoning ?? ''}`);
    analysis = res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`⚠️ ${model} #${issue.number}: ${message}`);
    analysis = null;
  }

  return analysis;
}

