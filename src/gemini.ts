import { GoogleGenerativeAI } from '@google/generative-ai';

export class GeminiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiResponseError';
  }
}

export class GeminiClient {
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  // Simple delay helper for backoff
  private sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(resolve, ms));
  }

  // Core single-attempt generate: do not export
  private async generate(model: string, payload: unknown): Promise<any> {
    const genModel = this.client.getGenerativeModel({ model });
    const result = await genModel.generateContent(payload as any);
    return result.response;
  }

  // Retry wrapper with exponential backoff: do not export
  private async generateWithRetries(
    model: string,
    payload: unknown,
    maxRetries: number,
    initialBackoffMs: number
  ): Promise<any> {
    let attempt = 0;
    const totalAttempts = (maxRetries | 0) + 1; // initial + retries
    let lastError: unknown = undefined;

    while (attempt < totalAttempts) {
      try {
        return await this.generate(model, payload);
      } catch (err) {
        lastError = err;
      }

      attempt++;
      if (attempt >= totalAttempts) break;
      const backoff = Math.max(1, initialBackoffMs * Math.pow(2, attempt - 1));
      await this.sleep(backoff);
    }

    // Exhausted
    const msg = `Gemini failed to generate a response: ${lastError instanceof Error ? lastError.message : String(lastError)}`;
    throw new GeminiResponseError(msg);
  }

  // Keep but private: pulls text out of SDK response shape
  private extractTextFromResponse(response: any): string {
    if (response && typeof response.text === 'function') {
      const text = response.text();
      if (typeof text === 'string') {
        if (text.trim().length > 0) return text;
        throw new GeminiResponseError('Gemini returned an empty response');
      }
    }

    const candidates = response?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
      const parts: any[] = candidates[0]?.content?.parts;
      if (Array.isArray(parts)) {
        const texts = parts
          .map(p => (p && typeof p.text === 'string' ? p.text : ''))
          .filter(Boolean);
        const combined = texts.join('');
        if (combined.trim().length > 0) return combined;
        throw new GeminiResponseError('Gemini returned an empty response');
      }
    }

    throw new GeminiResponseError('Unable to extract text from Gemini response');
  }

  // Get plain text from a prompt or full payload, with retry
  async generateText(
    model: string,
    payload: unknown,
    maxRetries: number = 0,
    initialBackoffMs: number = 0
  ): Promise<string> {
    const response = await this.generateWithRetries(model, payload, maxRetries, initialBackoffMs);
    return this.extractTextFromResponse(response);
  }

  // Set up JSON schema + enforce JSON output
  async generateJson<T = unknown>(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    schema: unknown,
    temperature?: string | number,
    thinkingBudget?: number,
    maxRetries: number = 2,
    initialBackoffMs: number = 15000
  ): Promise<T> {
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema as any,
        temperature: temperature as any,
        thinkingConfig: {
          thinkingBudget: thinkingBudget ?? -1, // -1 = dynamic
        },
      },
    };

    const response = await this.generateWithRetries(model, payload, maxRetries, initialBackoffMs);
    const text = this.extractTextFromResponse(response);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GeminiResponseError('Unable to parse JSON from Gemini response');
    }
  }
}
