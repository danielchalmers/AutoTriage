import { errorMessage } from '../util';
import { ModelApiError, ModelError } from './types';

// Capacity errors (503 UNAVAILABLE "high demand", 429 RESOURCE_EXHAUSTED) are outages, not bad requests.
// They get a longer, capped exponential schedule than the caller's default so a temporary spike doesn't fail every item in the backlog.
// Worst case per item: 10 + 20 + 40 + 60 + 60 + 60 = 250 seconds of waiting before giving up.
export const TRANSIENT_MAX_RETRIES = 6;
export const TRANSIENT_INITIAL_BACKOFF_MS = 10_000;
export const TRANSIENT_MAX_BACKOFF_MS = 60_000;

const TRANSIENT_STATUSES = new Set([429, 503]);

/**
 * True when the error is a capacity/rate-limit response that is worth waiting out.
 * A non-2xx response raises ModelApiError with the HTTP status; the message check covers wrapped errors and any other path that only preserves the JSON body.
 */
export function isTransientModelError(err: unknown): boolean {
  if (err instanceof ModelApiError && TRANSIENT_STATUSES.has(err.status)) return true;
  const message = errorMessage(err);
  return /"code"\s*:\s*(503|429)\b/.test(message) || /\b(UNAVAILABLE|RESOURCE_EXHAUSTED)\b/.test(message);
}

/**
 * Run one model call until it succeeds or its retry budget runs out.
 * `maxRetries`/`initialBackoffMs` govern ordinary failures (parse errors, rejected replies, 4xx, 5xx other than capacity).
 * Transient capacity errors (see isTransientModelError) switch to the longer TRANSIENT_* schedule instead, and each transient retry is logged so the run output shows the outage being waited out.
 * Giving up throws a ModelError with the last failure's message.
 */
export async function withRetries<T>(
  attempt: () => Promise<T>,
  maxRetries: number,
  initialBackoffMs: number,
  sleep: (ms: number) => Promise<void>
): Promise<T> {
  let ordinaryFailures = 0;
  let transientFailures = 0;
  let lastError: unknown = undefined;
  const maxOrdinaryFailures = (maxRetries | 0) + 1;
  const maxTransientFailures = TRANSIENT_MAX_RETRIES + 1;

  for (;;) {
    try {
      return await attempt();
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
    await sleep(backoff);
  }

  throw new ModelError(errorMessage(lastError));
}
