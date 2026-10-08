// Provider-neutral shapes shared by the model adapters and the code that calls them.

/** One call for a JSON reply that follows a response schema. */
export interface JsonRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  // Written in the Gemini API's schema dialect (see analysis.ts).
  schema: unknown;
  // A context cache that already holds the system prompt, so the prompt is not sent again.
  cacheName?: string | undefined;
  // Gemini's cheaper, slower flex tier, used alongside the cache on backlog runs.
  useFlexTier?: boolean | undefined;
}

export interface JsonResult<T> {
  data: T;
  thoughts: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}

export interface CacheInfo {
  name: string;
  tokenCount: number;
}

/** A model call that failed for good, or a reply that could not be used. Its message stands on its own in a log line. */
export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

/** A non-2xx response from a model API. The message is the error body as JSON, as @google/genai's ApiError built it. */
export class ModelApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ModelApiError';
    this.status = status;
  }
}
