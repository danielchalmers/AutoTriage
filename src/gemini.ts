import { saveArtifact } from './artifacts';
import { AnalysisResult } from './types';

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
};

export async function callGemini(
  prompt: string,
  model: string,
  apiKey: string,
  issueNumber: number
): Promise<AnalysisResult> {
  const payload = {
    contents: [{ parts: [{ text: prompt }]}],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING' },
          comment: { type: 'STRING' },
          labels: { type: 'ARRAY', items: { type: 'STRING' } },
          close: { type: 'BOOLEAN' },
          newTitle: { type: 'STRING' },
        },
        required: ['reason', 'labels']
      },
      temperature: 0.0,
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

export async function analyzeWithModels(
  prompt: string,
  issueNumber: number,
  apiKey: string,
  modelFast: string,
  modelPro: string,
): Promise<{ flash: AnalysisResult | null; pro: AnalysisResult | null; }> {
  let flash: AnalysisResult | null = null;
  try {
    flash = await callGemini(prompt, modelFast, apiKey, issueNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`flash failed for #${issueNumber}: ${message}. Proceeding to pro.`);
  }

  let pro: AnalysisResult | null = null;
  try {
    pro = await callGemini(prompt, modelPro, apiKey, issueNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`pro failed for #${issueNumber}: ${message}`);
  }

  return { flash, pro };
}
