export class GeminiClient {
  constructor(private apiKey: string) { }

  async generateContent(model: string, payload: unknown): Promise<any> {
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(payload),
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`NETWORK_ERROR: ${message}`);
    }

    if (response.status === 429) throw new Error('QUOTA_EXCEEDED');
    if (response.status === 500) throw new Error('MODEL_INTERNAL_ERROR');
    if (response.status === 503) throw new Error('MODEL_OVERLOADED');
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);

    return response.json();
  }
}

