import { ApiError } from '@google/genai'
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  GeminiClient,
  GeminiResponseError,
  isTransientModelError,
  TRANSIENT_INITIAL_BACKOFF_MS,
  TRANSIENT_MAX_BACKOFF_MS,
  TRANSIENT_MAX_RETRIES,
} from '../src/gemini'

const HIGH_DEMAND_BODY = '{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}'

function okResponse(json: string) {
  return { candidates: [{ content: { parts: [{ text: json }] } }], usageMetadata: {} }
}

// Subclass so the backoff is recorded instead of slept and the SDK client is a stub.
class TestClient extends GeminiClient {
  sleeps: number[] = []
  constructor(generateContent: (...args: any[]) => Promise<any>) {
    super('test-key')
    ;(this as any).client = { models: { generateContent } }
  }
  protected override sleep(ms: number): Promise<void> {
    this.sleeps.push(ms)
    return Promise.resolve()
  }
}

describe('isTransientModelError', () => {
  it('recognises 503 and 429 ApiErrors by status', () => {
    expect(isTransientModelError(new ApiError({ status: 503, message: 'x' }))).toBe(true)
    expect(isTransientModelError(new ApiError({ status: 429, message: 'x' }))).toBe(true)
    expect(isTransientModelError(new ApiError({ status: 400, message: 'x' }))).toBe(false)
    expect(isTransientModelError(new ApiError({ status: 500, message: 'x' }))).toBe(false)
  })

  it('recognises the high-demand JSON body when only the message survives', () => {
    expect(isTransientModelError(new Error(HIGH_DEMAND_BODY))).toBe(true)
    expect(isTransientModelError(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'))).toBe(true)
    expect(isTransientModelError(new Error('Unable to parse JSON from Gemini response'))).toBe(false)
    expect(isTransientModelError(new Error('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}'))).toBe(false)
  })
})

describe('GeminiClient.generateJson retry policy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the short caller-supplied schedule for ordinary failures', async () => {
    const generateContent = vi.fn().mockRejectedValue(new ApiError({ status: 400, message: 'bad request' }))
    const client = new TestClient(generateContent)

    await expect(client.generateJson({ model: 'm', contents: [] }, 2, 7500)).rejects.toBeInstanceOf(GeminiResponseError)
    expect(generateContent).toHaveBeenCalledTimes(3)
    expect(client.sleeps).toEqual([7500, 15000])
  })

  it('waits out a 503 outage with the longer capped schedule before giving up', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const generateContent = vi.fn().mockRejectedValue(new ApiError({ status: 503, message: HIGH_DEMAND_BODY }))
    const client = new TestClient(generateContent)

    await expect(client.generateJson({ model: 'm', contents: [] }, 2, 7500)).rejects.toThrow(/high demand/)
    expect(generateContent).toHaveBeenCalledTimes(TRANSIENT_MAX_RETRIES + 1)
    expect(client.sleeps).toEqual([10000, 20000, 40000, 60000, 60000, 60000])
    expect(client.sleeps[0]).toBe(TRANSIENT_INITIAL_BACKOFF_MS)
    expect(Math.max(...client.sleeps)).toBe(TRANSIENT_MAX_BACKOFF_MS)
  })

  it('recovers once the outage clears', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(new Error(HIGH_DEMAND_BODY))
      .mockRejectedValueOnce(new Error(HIGH_DEMAND_BODY))
      .mockRejectedValueOnce(new Error(HIGH_DEMAND_BODY))
      .mockResolvedValueOnce(okResponse('{"ok":true}'))
    const client = new TestClient(generateContent)

    const result = await client.generateJson<{ ok: boolean }>({ model: 'm', contents: [] }, 2, 7500)
    expect(result.data).toEqual({ ok: true })
    expect(generateContent).toHaveBeenCalledTimes(4)
    expect(client.sleeps).toEqual([10000, 20000, 40000])
  })

  it('does not let transient retries extend the budget for ordinary failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const generateContent = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ status: 503, message: HIGH_DEMAND_BODY }))
      .mockRejectedValueOnce(new ApiError({ status: 400, message: 'bad' }))
      .mockRejectedValueOnce(new ApiError({ status: 400, message: 'bad' }))
      .mockRejectedValueOnce(new ApiError({ status: 400, message: 'bad' }))
    const client = new TestClient(generateContent)

    await expect(client.generateJson({ model: 'm', contents: [] }, 2, 7500)).rejects.toThrow('bad')
    expect(generateContent).toHaveBeenCalledTimes(4)
    expect(client.sleeps).toEqual([10000, 7500, 15000])
  })
})
