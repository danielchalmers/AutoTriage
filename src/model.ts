import type { PromptPassMode } from './config';
import type { CacheInfo, JsonRequest, JsonResult } from './llm/types';

/**
 * What triage needs from a model provider: JSON replies, plus the context cache that backlog runs share across items.
 * GeminiClient (src/llm/gemini.ts) implements it.
 */
export interface ModelClient {
  /**
   * Call the model and parse its JSON reply.
   * `maxRetries`/`initialBackoffMs` govern ordinary failures, and `validate`, when given, narrows the parsed reply or throws to retry it.
   */
  generateJson<T = unknown>(
    request: JsonRequest,
    maxRetries: number,
    initialBackoffMs: number,
    validate?: (data: unknown) => T
  ): Promise<JsonResult<T>>;
  createCache(model: string, systemPrompt: string, displayName?: string): Promise<CacheInfo>;
  // Best effort: never throws.
  deleteCache(name: string): Promise<void>;
}

/**
 * The client each pass calls, since model-fast and model-pro can be served by different providers.
 * When the fast pass is skipped, its entry is the pro client and is never called.
 */
export type ModelClients = Record<PromptPassMode, ModelClient>;
