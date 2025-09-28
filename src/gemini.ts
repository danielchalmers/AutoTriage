import { GoogleGenAI, type GenerateContentParameters } from '@google/genai';

export function buildJsonPayload(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  schema: unknown,
  temperature?: number,
  thinkingBudget?: number
): GenerateContentParameters {
  const config: NonNullable<GenerateContentParameters['config']> = {
    systemInstruction: systemPrompt,
    responseMimeType: 'application/json',
    responseSchema: schema as any,
  };

  if (temperature !== undefined && Number.isFinite(temperature)) {
    config.temperature = temperature;
  }

  config.thinkingConfig = { thinkingBudget: thinkingBudget ?? -1 };

  return {
    model,
    contents: [
      {
        role: 'user',
        parts: [{ text: userPrompt }],
      },
    ],
    config,
  };
}

export class GeminiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiResponseError';
  }
}

export class GeminiClient {
  private client: GoogleGenAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  // Simple delay helper for backoff
  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private async generateAndParseJson<T>(payload: GenerateContentParameters): Promise<T> {
    const response = await this.client.models.generateContent(payload);

    const textFromGetter = typeof response.text === 'string' ? response.text : undefined;

    let text = textFromGetter;

    if (!text || text.trim().length === 0) {
      const candidates = response.candidates;
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new GeminiResponseError('Unable to extract text from Gemini response');
      }

      const parts = candidates[0]?.content?.parts;
      if (!Array.isArray(parts) || parts.length === 0) {
        throw new GeminiResponseError('Unable to extract text from Gemini response');
      }

      text = parts
        .map(part => {
          if (typeof part === 'string') return part;
          if (part && typeof part.text === 'string') return part.text;
          return '';
        })
        .filter(Boolean)
        .join('');

      if (!text || text.trim().length === 0) {
        throw new GeminiResponseError('Gemini returned an empty response');
      }
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiResponseError('Unable to parse JSON from Gemini response');
    }
  }

  // Set up JSON schema + enforce JSON output with retry handling
  async generateJson<T = unknown>(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<T> {
    let attempt = 0;
    let lastError: unknown = undefined;
    const totalAttempts = (maxRetries | 0) + 1;

    while (attempt < totalAttempts) {
      try {
        return await this.generateAndParseJson<T>(payload);
      } catch (err) {
        lastError = err;
      }

      attempt++;
      if (attempt >= totalAttempts) break;
      const backoff = Math.max(1, initialBackoffMs * Math.pow(2, attempt - 1));
      await this.sleep(backoff);
    }

    throw new GeminiResponseError(
      lastError instanceof Error ? lastError.message : String(lastError)
    );
  }
}
