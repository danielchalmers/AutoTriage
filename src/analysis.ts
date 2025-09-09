import * as core from '@actions/core';
import { saveArtifact } from './storage';
import { buildPrompt } from './prompt';
import type { IssueLike } from './github';
import type { Config } from './storage';

export type AnalysisResult = {
  summary: string;
  reasoning: string;
  labels?: string[];
  comment?: string;
  close?: boolean;
  newTitle?: string;
};

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

async function callGemini(
  prompt: string,
  model: string,
  apiKey: string,
  issueNumber: number,
  temperature: string
): Promise<AnalysisResult> {
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING' },
          reasoning: { type: 'STRING' },
          comment: { type: 'STRING' },
          labels: { type: 'ARRAY', items: { type: 'STRING' } },
          close: { type: 'BOOLEAN' },
          newTitle: { type: 'STRING' },
        },
        required: ['summary', 'reasoning', 'labels']
      },
      temperature: temperature
    },
  };

  let response: Response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`NETWORK_ERROR: ${message}`);
  }

  if (response.status === 429) throw new Error('QUOTA_EXCEEDED');
  if (response.status === 500) throw new Error('SERVER_ERROR');
  if (response.status === 503) throw new Error('MODEL_OVERLOADED');
  if (!response.ok) throw new Error(`HTTP_${response.status}`);

  const data = (await response.json()) as GeminiResponse;
  saveArtifact(issueNumber, `gemini-output-${model}.json`, JSON.stringify(data, null, 2));

  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('INVALID_RESPONSE: empty');
  }

  try {
    return JSON.parse(raw) as AnalysisResult;
  } catch {
    throw new Error('INVALID_RESPONSE: parse_error');
  }
}

export async function generateAnalysis(
  cfg: Config,
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
    const res = await callGemini(prompt, model, cfg.geminiApiKey, issue.number, cfg.modelTemperature);
    saveArtifact(issue.number, `analysis-${model}.json`, JSON.stringify(res, null, 2));
    core.info(`🤖 ${model} #${issue.number}:`);
    core.info(`💭 ${(res as any).summary ?? ''}`);
    core.info(`💭 ${(res as any).reasoning ?? ''}`);
    analysis = res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`⚠️ ${model} #${issue.number}: ${message}`);
    analysis = null;
  }

  return analysis;
}

