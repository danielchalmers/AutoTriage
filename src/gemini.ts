import { GenerateContentResponse, GoogleGenAI, ThinkingLevel, type GenerateContentParameters } from '@google/genai';
import { errorMessage } from './util';

// Single source of truth for the thinking budget, also stamped into run telemetry.
export const THINKING_LEVEL = ThinkingLevel.HIGH;

export interface GeminiCacheInfo {
  name: string;
  tokenCount: number;
}

export interface GeminiJsonResult<T> {
  data: T;
  thoughts: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export function buildJsonPayload(
  systemPrompt: string,
  userPrompt: string,
  schema: unknown,
  model: string,
  cachedContentName?: string,
  useFlexTier?: boolean
): GenerateContentParameters {
  const config: NonNullable<GenerateContentParameters['config']> = {
    responseMimeType: 'application/json',
    responseSchema: schema as any,
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: THINKING_LEVEL,
    }
  };

  // When using a cache, the system instruction is already part of the cached content.
  if (cachedContentName) {
    config.cachedContent = cachedContentName;
  } else {
    config.systemInstruction = systemPrompt;
  }
  if (useFlexTier) {
    config.httpOptions = {
      headers: {},
      timeout: 600000,
      extraBody: {
        service_tier: 'flex',
      },
    };
  }

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

  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create a context cache for the given system prompt and model.
   * Returns the cache resource name to be used in subsequent generateContent calls.
   */
  async createCache(model: string, systemPrompt: string, displayName?: string): Promise<GeminiCacheInfo> {
    const cache = await this.client.caches.create({
      model,
      config: {
        displayName: displayName || 'autotriage-context',
        systemInstruction: systemPrompt,
        ttl: '3600s',
      },
    });
    if (!cache.name) {
      throw new GeminiResponseError('Failed to create context cache: no name returned');
    }
    return {
      name: cache.name,
      tokenCount: cache.usageMetadata?.totalTokenCount ?? 0,
    };
  }

  /**
   * Delete a previously created context cache.
   */
  async deleteCache(name: string): Promise<void> {
    try {
      await this.client.caches.delete({ name });
    } catch {
      // Best-effort cleanup; caches expire automatically via TTL
    }
  }

  private async parseJson<T>(response: GenerateContentResponse): Promise<GeminiJsonResult<T>> {
    // Manually extract text from parts to avoid warnings about non-text parts when Gemini 3 thinking responses include dedicated thought parts.
    const thoughts: string[] = [];
    const textParts: string[] = [];
    
    for (const p of response.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p.text === 'string') {
        if (p.thought) {
          thoughts.push(p.text);
        } else {
          textParts.push(p.text);
        }
      }
    }

    const jsonText = textParts.join('');
    if (!jsonText) {
      throw new GeminiResponseError('Gemini responded with empty text');
    }

    try {
      const data = JSON.parse(jsonText) as T;
      const collapsedThoughts = thoughts
        .join('\n')
        .replace(/(\r?\n\s*){2,}/g, '\n')
        .trim();

      // Extract token usage from response metadata.
      // thoughtsTokenCount is the hidden thinking budget Gemini 3 spends before emitting candidates; it is billed but excluded from candidatesTokenCount, so capture it explicitly to make per-pass thinking cost measurable.
      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const cachedInputTokens = response.usageMetadata?.cachedContentTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
      const thoughtsTokens = response.usageMetadata?.thoughtsTokenCount ?? 0;

      return { data, thoughts: collapsedThoughts, inputTokens, cachedInputTokens, outputTokens, thoughtsTokens };
    } catch {
      throw new GeminiResponseError('Unable to parse JSON from Gemini response');
    }
  }

  async generateJson<T = unknown>(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<GeminiJsonResult<T>> {
    let attempt = 0;
    let lastError: unknown = undefined;
    const totalAttempts = (maxRetries | 0) + 1;

    while (attempt < totalAttempts) {
      try {
        const response = await this.client.models.generateContent(payload);
        return await this.parseJson<T>(response);
      } catch (err) {
        lastError = err;
      }

      attempt++;
      if (attempt >= totalAttempts) break;
      const backoff = Math.max(1, initialBackoffMs * Math.pow(2, attempt - 1));
      await this.sleep(backoff);
    }

    throw new GeminiResponseError(errorMessage(lastError));
  }
}
