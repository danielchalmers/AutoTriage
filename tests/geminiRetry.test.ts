import { afterEach, describe, it, expect, vi } from 'vitest'
import { GeminiClient } from '../src/llm/gemini'
import { classifyApiError } from '../src/llm/errors'
import {
  failureOf,
  TRANSIENT_INITIAL_BACKOFF_MS,
  TRANSIENT_MAX_BACKOFF_MS,
  TRANSIENT_MAX_RETRIES,
  withRetries,
} from '../src/llm/retry'
import type { Fetch } from '../src/llm/transport'
import { ModelApiError, ModelError } from '../src/llm/types'

const HIGH_DEMAND_BODY = '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'

// Runs the retry loop over a mocked attempt, recording each backoff instead of sleeping.
async function retry<T>(attempt: () => Promise<T>, maxRetries = 2, initialBackoffMs = 7500) {
  const sleeps: number[] = []
  const result = withRetries(attempt, maxRetries, initialBackoffMs, async ms => { sleeps.push(ms) })
  return { result: await result.then(value => ({ value }), (error: unknown) => ({ error })), sleeps }
}

// Stands in for a shape check such as parseAnalysisResult.
function requireObject(data: unknown) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('reply is not an object')
  return data as { ok: boolean }
}

function okResponse(json: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] } }], usageMetadata: {} }), { headers: { 'content-type': 'application/json' } })
}

// Error bodies as each provider documents them, so the shared classifier is pinned against real shapes.
const GEMINI_BAD_KEY = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com"}]}}'
const GEMINI_PER_DAY_QUOTA = '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'
const GEMINI_BAD_REQUEST = '{"error":{"code":400,"message":"Invalid JSON payload received.","status":"INVALID_ARGUMENT"}}'
const OPENAI_NO_QUOTA = '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}'
const OPENAI_SPEND_LIMIT = '{"error":{"message":"Project spend limit reached.","type":"invalid_request_error","code":"project_spend_limit_exceeded"}}'
const OPENAI_RATE_LIMIT = '{"error":{"message":"Rate limit reached for gpt-6-luna on tokens per min (TPM).","type":"tokens","code":"rate_limit_exceeded"}}'
const ANTHROPIC_NO_CREDIT = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'
const ANTHROPIC_USAGE_LIMIT = '{"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits."}}'
const ANTHROPIC_OVERLOADED = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'

describe('classifyApiError', () => {
  it('fails fast on a rejected key, an unknown model, or an account out of credit', () => {
    expect(classifyApiError(400, GEMINI_BAD_KEY)).toEqual({ kind: 'fatal', cause: 'auth' })
    expect(classifyApiError(401, '{"error":{"message":"Incorrect API key provided."}}')).toEqual({ kind: 'fatal', cause: 'auth' })
    expect(classifyApiError(403, '{"error":{"status":"PERMISSION_DENIED"}}')).toEqual({ kind: 'fatal', cause: 'auth' })
    expect(classifyApiError(404, '{"error":{"status":"NOT_FOUND"}}')).toEqual({ kind: 'fatal', cause: 'model' })
    expect(classifyApiError(402, '{}')).toEqual({ kind: 'fatal', cause: 'quota' })
    expect(classifyApiError(429, OPENAI_NO_QUOTA)).toEqual({ kind: 'fatal', cause: 'quota' })
    expect(classifyApiError(429, OPENAI_SPEND_LIMIT)).toEqual({ kind: 'fatal', cause: 'quota' })
    expect(classifyApiError(400, ANTHROPIC_NO_CREDIT)).toEqual({ kind: 'fatal', cause: 'quota' })
    expect(classifyApiError(400, ANTHROPIC_USAGE_LIMIT)).toEqual({ kind: 'fatal', cause: 'quota' })
  })

  it('waits out overloads and rate limits, including Gemini per-day quotas', () => {
    expect(classifyApiError(503, HIGH_DEMAND_BODY)).toEqual({ kind: 'capacity' })
    expect(classifyApiError(429, GEMINI_PER_DAY_QUOTA)).toEqual({ kind: 'capacity' })
    expect(classifyApiError(429, OPENAI_RATE_LIMIT)).toEqual({ kind: 'capacity' })
    expect(classifyApiError(529, ANTHROPIC_OVERLOADED)).toEqual({ kind: 'capacity' })
    expect(classifyApiError(500, '{"error":{"code":500,"status":"UNAVAILABLE"}}')).toEqual({ kind: 'capacity' })
  })

  it('retries other server errors, timeouts and conflicts, and treats any other client error as permanent', () => {
    for (const status of [500, 502, 504]) {
      expect(classifyApiError(status, '{}'), String(status)).toEqual({ kind: 'retryable' })
    }
    expect(classifyApiError(408, '{}')).toEqual({ kind: 'retryable' })
    expect(classifyApiError(409, '{"error":{"code":409,"status":"ABORTED"}}')).toEqual({ kind: 'retryable' })
    expect(classifyApiError(400, GEMINI_BAD_REQUEST)).toEqual({ kind: 'permanent' })
    expect(classifyApiError(413, '{}')).toEqual({ kind: 'permanent' })
  })
})

describe('failureOf', () => {
  it('reads the failure a model error carries', () => {
    expect(failureOf(new ModelApiError('x', 503))).toEqual({ kind: 'capacity' })
    expect(failureOf(new ModelApiError(GEMINI_BAD_KEY, 400))).toEqual({ kind: 'fatal', cause: 'auth' })
    expect(failureOf(new ModelError('cut off', { kind: 'truncated' }))).toEqual({ kind: 'truncated' })
    expect(failureOf(new ModelError('bad reply'))).toEqual({ kind: 'retryable' })
  })

  it('recognises the high-demand JSON body when only the message survives', () => {
    expect(failureOf(new Error(HIGH_DEMAND_BODY))).toEqual({ kind: 'capacity' })
    expect(failureOf(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'))).toEqual({ kind: 'capacity' })
    expect(failureOf(new Error('Unable to parse JSON from Gemini response'))).toEqual({ kind: 'retryable' })
    expect(failureOf(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'))).toEqual({ kind: 'retryable' })
  })
})

describe('withRetries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the short caller-supplied schedule for retryable failures', async () => {
    const attempt = vi.fn().mockRejectedValue(new ModelApiError('server error', 500))

    const { result, sleeps } = await retry(attempt)

    expect(result).toEqual({ error: new ModelError('server error') })
    expect((result as { error: ModelError }).error).toBeInstanceOf(ModelError)
    expect((result as { error: ModelError }).error.failure).toEqual({ kind: 'retryable' })
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([7500, 15000])
  })

  it('throws at once on failures a retry cannot fix, keeping their kind', async () => {
    const failures = [
      new ModelApiError(GEMINI_BAD_REQUEST, 400),
      new ModelApiError(GEMINI_BAD_KEY, 400),
      new ModelApiError('{}', 404),
      new ModelError('cut off', { kind: 'truncated' }),
      new ModelError('declined', { kind: 'refusal' }),
    ]

    for (const failure of failures) {
      const attempt = vi.fn().mockRejectedValue(failure)

      const { result, sleeps } = await retry(attempt)

      const error = (result as { error: ModelError }).error
      expect(error, failure.message).toBeInstanceOf(ModelError)
      expect(error.message).toBe(failure.message)
      expect(error.failure).toEqual(failure.failure)
      expect(attempt).toHaveBeenCalledOnce()
      expect(sleeps).toEqual([])
    }
  })

  it('waits at least as long as Retry-After asks, but no longer than the capacity cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new ModelApiError(HIGH_DEMAND_BODY, 503, { retryAfterSeconds: 30 }))
      .mockRejectedValueOnce(new ModelApiError(HIGH_DEMAND_BODY, 503, { retryAfterSeconds: 30 }))
      .mockRejectedValueOnce(new ModelApiError(HIGH_DEMAND_BODY, 503, { retryAfterSeconds: 5 }))
      .mockRejectedValueOnce(new ModelApiError(HIGH_DEMAND_BODY, 503, { retryAfterSeconds: 3600 }))
      .mockResolvedValueOnce({ ok: true })

    const { result, sleeps } = await retry(attempt)

    expect(result).toEqual({ value: { ok: true } })
    expect(sleeps).toEqual([30000, 30000, 40000, 60000])
  })

  it('waits out a 503 outage with the longer capped schedule before giving up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi.fn().mockRejectedValue(new ModelApiError(HIGH_DEMAND_BODY, 503))

    const { result, sleeps } = await retry(attempt)

    expect((result as { error: Error }).error.message).toMatch(/high demand/)
    expect((result as { error: ModelError }).error.failure).toEqual({ kind: 'capacity' })
    expect(attempt).toHaveBeenCalledTimes(TRANSIENT_MAX_RETRIES + 1)
    expect(sleeps).toEqual([10000, 20000, 40000, 60000, 60000, 60000])
    expect(sleeps[0]).toBe(TRANSIENT_INITIAL_BACKOFF_MS)
    expect(Math.max(...sleeps)).toBe(TRANSIENT_MAX_BACKOFF_MS)
    expect(warn).toHaveBeenCalledWith(`Model unavailable (attempt 1/7); retrying in 10s: ${HIGH_DEMAND_BODY}`)
  })

  it('recovers once the outage clears', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error(HIGH_DEMAND_BODY))
      .mockRejectedValueOnce(new Error(HIGH_DEMAND_BODY))
      .mockRejectedValueOnce(new Error(HIGH_DEMAND_BODY))
      .mockResolvedValueOnce({ ok: true })

    const { result, sleeps } = await retry(attempt)

    expect(result).toEqual({ value: { ok: true } })
    expect(attempt).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([10000, 20000, 40000])
  })

  it('does not let transient retries extend the budget for retryable failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new ModelApiError(HIGH_DEMAND_BODY, 503))
      .mockRejectedValueOnce(new ModelApiError('bad', 502))
      .mockRejectedValueOnce(new ModelApiError('bad', 502))
      .mockRejectedValueOnce(new ModelApiError('bad', 502))

    const { result, sleeps } = await retry(attempt)

    expect((result as { error: Error }).error.message).toBe('bad')
    expect(attempt).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([10000, 7500, 15000])
  })

  it('keeps the network cause code in the final message', async () => {
    const attempt = vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))

    const { result } = await retry(attempt, 0)

    expect((result as { error: Error }).error.message).toBe('fetch failed (ECONNRESET)')
  })
})

describe('GeminiClient.generateJson validation', () => {
  // Answers each request with the next reply, and records backoff instead of sleeping.
  function makeClient(...replies: string[]) {
    const fetch = vi.fn<Fetch>(async () => okResponse(replies.length > 1 ? replies.shift()! : replies[0]!))
    const client = new GeminiClient('test-key', fetch)
    const sleep = vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined)
    return { client, fetch, sleep }
  }

  const REQUEST = { model: 'm', systemPrompt: 'system', userPrompt: 'user', schema: {} }

  it('retries a reply the validator rejects on the ordinary schedule', async () => {
    const { client, fetch, sleep } = makeClient('[]', '{"ok":true}')

    const result = await client.generateJson(REQUEST, 2, 7500, requireObject)

    expect(result.data).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls).toEqual([[7500]])
  })

  it('gives up with the validator error once ordinary retries run out', async () => {
    const { client, fetch, sleep } = makeClient('[]')

    await expect(client.generateJson(REQUEST, 2, 7500, requireObject)).rejects.toThrow('reply is not an object')
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[7500], [15000]])
  })
})
