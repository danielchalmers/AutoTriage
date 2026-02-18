import { GenerateContentResponse, GoogleGenAI, type GenerateContentParameters } from '@google/genai';

export function buildJsonPayload(
  systemPrompt: string,
  userPrompt: string,
  schema: unknown,
  model: string,
  temperature: number,
  thinkingBudget?: number,
  cachedContentName?: string
): GenerateContentParameters {
  const config: NonNullable<GenerateContentParameters['config']> = {
    responseMimeType: 'application/json',
    responseSchema: schema as any,
    temperature: temperature,
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: thinkingBudget ?? -1
    }
  };

  // When using a cache, the system instruction is already part of the cached content.
  if (cachedContentName) {
    config.cachedContent = cachedContentName;
  } else {
    config.systemInstruction = systemPrompt;
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
  async createCache(model: string, systemPrompt: string, displayName?: string): Promise<string> {
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
    return cache.name;
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

  private async parseJson<T>(response: GenerateContentResponse): Promise<{ data: T; thoughts: string; inputTokens: number; outputTokens: number }> {
    // Manually extract text from parts to avoid warnings about non-text parts (e.g., thoughtSignature)
    // when using Gemini 3 models with thinking enabled
    const thoughts: string[] = [];
    const textParts: string[] = [];
    
    for (const p of response.candidates?.[0]?.content?.parts ?? []) {
      if (typeof p.text === 'string') {
        if (p.thought) {
          // This is a thought part - collect it separately
          thoughts.push(p.text);
        } else {
          // This is a regular text part - use it for JSON parsing
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

      // Extract token usage from response metadata
      const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

      return { data, thoughts: collapsedThoughts, inputTokens, outputTokens };
    } catch {
      throw new GeminiResponseError('Unable to parse JSON from Gemini response');
    }
  }

  async generateJson<T = unknown>(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<{ data: T; thoughts: string; inputTokens: number; outputTokens: number }> {
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

    throw new GeminiResponseError(
      lastError instanceof Error ? lastError.message : String(lastError)
    );
  }
}
