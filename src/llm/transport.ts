import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { ModelApiError } from './types';

export type Fetch = typeof globalThis.fetch;

// Deadline for every model request, so a stuck call fails instead of hanging the run.
// Flex calls can take minutes to start answering, so it is generous.
export const MODEL_TIMEOUT_MS = 600_000;

/**
 * Fetch for model requests, using undici's own fetch with a dedicated dispatcher.
 * Node's built-in fetch gives up on any response whose headers take longer than 300s, and a longer AbortSignal cannot lift that.
 * The dispatcher's own timers are off by default so MODEL_TIMEOUT_MS is the only deadline; tests pass a short timeout to prove requests go through it.
 * It is passed with each request rather than installed as Node's global dispatcher, so GitHub API traffic is unchanged.
 * Node's built-in fetch only honors HTTP(S)_PROXY and NO_PROXY when NODE_USE_ENV_PROXY=1, so model traffic keeps that behavior.
 */
export function createModelFetch(dispatcherTimeoutMs = 0): Fetch {
  const options = { headersTimeout: dispatcherTimeoutMs, bodyTimeout: dispatcherTimeoutMs };
  const dispatcher = process.env.NODE_USE_ENV_PROXY === '1' ? new EnvHttpProxyAgent(options) : new Agent(options);
  const modelFetch: typeof undiciFetch = (input, init) => undiciFetch(input, { ...init, dispatcher });
  // undici's types come from a different release than Node's built-in fetch types, so TypeScript cannot match them even though the API is the same.
  return modelFetch as Fetch;
}

export interface ModelRequestInit {
  method: 'POST' | 'DELETE';
  headers: Record<string, string>;
  body: string;
}

/**
 * Send one model request and return its JSON body.
 * The deadline covers reading the body too, and a request still running when it passes is aborted with an AbortError.
 * Network failures propagate as fetch reports them, and a non-2xx response throws as described in responseError.
 */
export async function requestJson(fetch: Fetch, url: string, init: ModelRequestInit, timeoutMs = MODEL_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The deadline alone must not keep the process alive.
  timer.unref();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw await responseError(response);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The error for a non-2xx response, with the same message @google/genai gave it so log lines and failure strings don't change.
 * The message is the JSON error body, or the text body wrapped in the same `{"error": ...}` shape when the response isn't JSON.
 * A 4xx or 5xx gives a ModelApiError carrying the status; anything else gives a plain Error.
 */
async function responseError(response: Response): Promise<Error> {
  const errorBody: unknown = response.headers.get('content-type')?.includes('application/json')
    ? await response.json()
    : { error: { message: await response.text(), code: response.status, status: response.statusText } };
  const message = JSON.stringify(errorBody);
  return response.status >= 400 && response.status < 600 ? new ModelApiError(message, response.status) : new Error(message);
}
