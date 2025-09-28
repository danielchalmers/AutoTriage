// @ts-ignore: Google Gemini SDK ships without TypeScript declarations
import { GoogleGenAI } from '@google/genai';

export type GenerateContentParameters = {
  model: string;
  contents: Array<{
    role: string;
    parts: Array<{
      text?: string;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  }>;
  config?: {
    systemInstruction?: string;
    responseMimeType?: string;
    responseSchema?: unknown;
    temperature?: number;
    thinkingConfig?: {
      thinkingBudget?: number;
      includeThoughts?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function buildJsonPayload(
  systemPrompt: string,
  userPrompt: string,
  schema: unknown,
  model: string,
  temperature: number,
  thinkingBudget?: number
): GenerateContentParameters {
  const config: NonNullable<GenerateContentParameters['config']> = {
    systemInstruction: systemPrompt,
    responseMimeType: 'application/json',
    responseSchema: schema as any,
    temperature: temperature,
    thinkingConfig: {
      thinkingBudget: thinkingBudget ?? -1,
      includeThoughts: true,
    }
  };

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

  private async generateAndParseJson<T>(payload: GenerateContentParameters): Promise<{ result: T; thoughts: string }> {
    const response = await this.client.models.generateContent(payload);

    const candidates = Array.isArray((response as any)?.candidates)
      ? (response as any).candidates
      : [];

    const parts = candidates.flatMap((candidate: any) =>
      Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []
    );

    const thoughtParts: string[] = [];
    for (const part of parts) {
      if (part && typeof part.text === 'string' && part.thought) {
        thoughtParts.push(part.text);
      }
    }
    const thoughts = thoughtParts.join('\n');

    let text: string | undefined;

    const nonThoughtTexts = parts
      .map((part: any) => {
        if (part && typeof part.text === 'string' && !part.thought) {
          return part.text;
        }
        if (typeof part === 'string') return part;
        return '';
      })
      .filter((value: string) => value && value.trim().length > 0);

    if (nonThoughtTexts.length > 0) {
      text = nonThoughtTexts.join('');
    }

    if (!text || text.trim().length === 0) {
      const textFromGetter = typeof (response as any).text === 'string' ? (response as any).text : undefined;
      text = textFromGetter;
    }

    if (!text || text.trim().length === 0) {
      throw new GeminiResponseError('Unable to extract text from Gemini response');
    }

    try {
      const parsed = JSON.parse(text) as T;
      return { result: parsed, thoughts };
    } catch {
      throw new GeminiResponseError('Unable to parse JSON from Gemini response');
    }
  }

  // Set up JSON schema + enforce JSON output with retry handling
  async generateJson<T = unknown>(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<{ result: T; thoughts: string }> {
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
