import * as core from '@actions/core';
import { AnalysisResult, Config } from './types';
import { saveArtifact } from './storage';

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

async function callGemini(
  prompt: string,
  model: string,
  apiKey: string,
  issueNumber: number,
  temperature: number
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
      temperature: temperature,
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

export type StageName = 'quick' | 'review';

export async function evaluateStage(
  cfg: Config,
  issueNumber: number,
  model: string,
  basePrompt: string,
  stage: StageName
): Promise<AnalysisResult | null> {
  const prompt = basePrompt;
  saveArtifact(issueNumber, `gemini-input-${model}.${stage}.md`, prompt);
  try {
    const res = await callGemini(prompt, model, cfg.geminiApiKey, issueNumber, cfg.modelTemperature);
    saveArtifact(issueNumber, `analysis-${model}.${stage}.json`, JSON.stringify(res, null, 2));
    core.info(`${model} [${stage}] OK for #${issueNumber}`);
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`${model} [${stage}] failed for #${issueNumber}: ${message}`);
    return null;
  }
}
