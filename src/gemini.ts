import { GenerateContentResponse, GoogleGenAI, type GenerateContentParameters } from '@google/genai';

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
      includeThoughts: true,
      thinkingBudget: thinkingBudget ?? -1
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export class GeminiClient {
  private client: GoogleGenAI;
  public totalInputTokens: number = 0;
  public totalOutputTokens: number = 0;

  constructor(apiKey: string) {
    this.client = new GoogleGenAI({ apiKey });
  }

  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  private async parseJson<T>(response: GenerateContentResponse): Promise<{ data: T; thoughts: string; usage?: TokenUsage }> {
    const jsonText = response.text;
    if (!jsonText) {
      throw new GeminiResponseError('Gemini responded with empty text');
    }

    const thoughts: string[] = [];
    for (const p of response.candidates?.[0]?.content?.parts ?? []) {
      if (p.thought && typeof p.text === 'string') {
        thoughts.push(p.text);
      }
    }

    try {
      const data = JSON.parse(jsonText) as T;
      const collapsedThoughts = thoughts
        .join('\n')
        .replace(/(\r?\n\s*){2,}/g, '\n')
        .trim();

      // Extract token usage from response
      const usage: TokenUsage | undefined = response.usageMetadata ? {
        inputTokens: response.usageMetadata.promptTokenCount || 0,
        outputTokens: response.usageMetadata.candidatesTokenCount || 0
      } : undefined;

      return { data, thoughts: collapsedThoughts, usage };
    } catch {
      throw new GeminiResponseError('Unable to parse JSON from Gemini response');
    }
  }

  async generateJson<T = unknown>(
    payload: GenerateContentParameters,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<{ data: T; thoughts: string; usage?: TokenUsage }> {
    let attempt = 0;
    let lastError: unknown = undefined;
    const totalAttempts = (maxRetries | 0) + 1;

    while (attempt < totalAttempts) {
      try {
        const response = await this.client.models.generateContent(payload);
        const result = await this.parseJson<T>(response);
        
        // Track token usage
        if (result.usage) {
          this.totalInputTokens += result.usage.inputTokens;
          this.totalOutputTokens += result.usage.outputTokens;
        }
        
        return result;
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
