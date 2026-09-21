import { ApiError, GenerateContentResponse, GoogleGenAI, ThinkingLevel, type GenerateContentParameters } from '@google/genai';
import { errorMessage } from './util';

// Capacity errors (503 UNAVAILABLE "high demand", 429 RESOURCE_EXHAUSTED) are outages, not bad requests.
// They get a longer, capped exponential schedule than the caller's default so a temporary spike doesn't fail every item in the backlog.
// Worst case per item: 10 + 20 + 40 + 60 + 60 + 60 = 250 seconds of waiting before giving up.
export const TRANSIENT_MAX_RETRIES = 6;
export const TRANSIENT_INITIAL_BACKOFF_MS = 10_000;
export const TRANSIENT_MAX_BACKOFF_MS = 60_000;

const TRANSIENT_STATUSES = new Set([429, 503]);

/**
 * True when the error is a capacity/rate-limit response that is worth waiting out.
 * The SDK raises ApiError with the HTTP status for most failures; the message check covers wrapped errors and any other path that only preserves the JSON body.
 */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof ApiError && TRANSIENT_STATUSES.has(err.status)) return true;
  const message = errorMessage(err);
  return /"code"\s*:\s*(503|429)\b/.test(message) || /\b(UNAVAILABLE|RESOURCE_EXHAUSTED)\b/.test(message);
}

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

  protected sleep(ms: number) {
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

  /**
   * Call the model and parse its JSON reply.
   * `maxRetries`/`initialBackoffMs` govern ordinary failures (parse errors, 4xx, 5xx other than capacity).
   * Transient capacity errors (see isTransientModelError) switch to the longer TRANSIENT_* schedule instead, and each transient retry is logged so the run output shows the outage being waited out.
   */
  async generateJson<T = unknown>(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<GeminiJsonResult<T>> {
    let ordinaryFailures = 0;
    let transientFailures = 0;
    let lastError: unknown = undefined;
    const maxOrdinaryFailures = (maxRetries | 0) + 1;
    const maxTransientFailures = TRANSIENT_MAX_RETRIES + 1;

    for (;;) {
      try {
        const response = await this.client.models.generateContent(payload);
        return await this.parseJson<T>(response);
      } catch (err) {
        lastError = err;
      }

      let backoff: number;
      if (isTransientModelError(lastError)) {
        transientFailures++;
        if (transientFailures >= maxTransientFailures) break;
        backoff = Math.min(TRANSIENT_MAX_BACKOFF_MS, TRANSIENT_INITIAL_BACKOFF_MS * Math.pow(2, transientFailures - 1));
        console.warn(`Model unavailable (attempt ${transientFailures}/${maxTransientFailures}); retrying in ${Math.round(backoff / 1000)}s: ${errorMessage(lastError)}`);
      } else {
        ordinaryFailures++;
        if (ordinaryFailures >= maxOrdinaryFailures) break;
        backoff = Math.max(1, initialBackoffMs * Math.pow(2, ordinaryFailures - 1));
      }
      await this.sleep(backoff);
    }

    throw new GeminiResponseError(errorMessage(lastError));
  }
}
