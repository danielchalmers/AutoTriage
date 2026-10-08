import { afterEach, describe, it, expect, vi } from 'vitest'
import { GeminiClient } from '../src/llm/gemini'
import {
  isTransientModelError,
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

describe('isTransientModelError', () => {
  it('recognises 503 and 429 API errors by status', () => {
    expect(isTransientModelError(new ModelApiError('x', 503))).toBe(true)
    expect(isTransientModelError(new ModelApiError('x', 429))).toBe(true)
    expect(isTransientModelError(new ModelApiError('x', 400))).toBe(false)
    expect(isTransientModelError(new ModelApiError('x', 500))).toBe(false)
  })

  it('recognises the high-demand JSON body when only the message survives', () => {
    expect(isTransientModelError(new Error(HIGH_DEMAND_BODY))).toBe(true)
    expect(isTransientModelError(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'))).toBe(true)
    expect(isTransientModelError(new Error('Unable to parse JSON from Gemini response'))).toBe(false)
    expect(isTransientModelError(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'))).toBe(false)
  })
})

describe('withRetries', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the short caller-supplied schedule for ordinary failures', async () => {
    const attempt = vi.fn().mockRejectedValue(new ModelApiError('bad request', 400))

    const { result, sleeps } = await retry(attempt)

    expect(result).toEqual({ error: new ModelError('bad request') })
    expect((result as { error: unknown }).error).toBeInstanceOf(ModelError)
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([7500, 15000])
  })

  it('waits out a 503 outage with the longer capped schedule before giving up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi.fn().mockRejectedValue(new ModelApiError(HIGH_DEMAND_BODY, 503))

    const { result, sleeps } = await retry(attempt)

    expect((result as { error: Error }).error.message).toMatch(/high demand/)
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

  it('does not let transient retries extend the budget for ordinary failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new ModelApiError(HIGH_DEMAND_BODY, 503))
      .mockRejectedValueOnce(new ModelApiError('bad', 400))
      .mockRejectedValueOnce(new ModelApiError('bad', 400))
      .mockRejectedValueOnce(new ModelApiError('bad', 400))

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
