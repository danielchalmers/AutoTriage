import { describe, it, expect, vi } from 'vitest'
import { GeminiClient, GeminiResponseError, geminiModelPath } from '../src/llm/gemini'
import type { Fetch } from '../src/llm/transport'
import { ModelError, type JsonRequest } from '../src/llm/types'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

// Answers each request with the next reply in turn, and records backoff instead of sleeping.
function makeClient(...replies: Array<unknown | Error>) {
  const fetch = vi.fn<Fetch>(async () => {
    const reply = replies.length > 1 ? replies.shift() : replies[0]
    if (reply instanceof Error) throw reply
    return jsonResponse(reply)
  })
  const client = new GeminiClient('test-key', fetch)
  vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined)
  return { client, fetch }
}

function sentBody(fetch: ReturnType<typeof makeClient>['fetch'], call = 0): any {
  return JSON.parse(String(fetch.mock.calls[call]![1]?.body))
}

function reply(...parts: unknown[]) {
  return { candidates: [{ content: { parts } }] }
}

const REQUEST: JsonRequest = { model: 'm', systemPrompt: 'system', userPrompt: 'user', schema: {} }

describe('GeminiClient.generateJson response parsing', () => {
  it('separates thought parts from the JSON answer and reports token usage', async () => {
    const { client } = makeClient({
      ...reply(
        { text: 'First thought.\n\n\n', thought: true },
        { text: '{"summary":' },
        { text: 'Second thought.', thought: true },
        { text: '"ok","operations":[]}' },
        { inlineData: {} },
      ),
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 50, thoughtsTokenCount: 400 },
    })

    const result = await client.generateJson(REQUEST, 2, 1)

    expect(result).toEqual({
      data: { summary: 'ok', operations: [] },
      thoughts: 'First thought.\nSecond thought.',
      inputTokens: 1000,
      cachedInputTokens: 800,
      outputTokens: 50,
      thoughtsTokens: 400,
    })
  })

  it('defaults token counts to zero when usage metadata is absent', async () => {
    const { client } = makeClient(reply({ text: '{}' }))

    const result = await client.generateJson(REQUEST, 0, 1)

    expect(result).toMatchObject({ thoughts: '', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtsTokens: 0 })
  })

  it('retries malformed JSON and reports a parse error once retries run out', async () => {
    const { client, fetch } = makeClient(reply({ text: '{"summary": ' }))

    await expect(client.generateJson(REQUEST, 1, 1)).rejects.toThrow('Unable to parse JSON from Gemini response')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('treats a response with only thoughts as empty', async () => {
    const { client } = makeClient(reply({ text: 'hmm', thought: true }))

    await expect(client.generateJson(REQUEST, 0, 1)).rejects.toThrow('Gemini responded with empty text')
  })

  it('treats a response without candidates as empty', async () => {
    const { client } = makeClient({})

    await expect(client.generateJson(REQUEST, 0, 1)).rejects.toThrow('Gemini responded with empty text')
  })
})

describe('GeminiClient.generateJson failure kinds', () => {
  function errorResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  // Calls with a generous retry budget, so a failure that is thrown after one request proves it was not retried.
  async function failure(fetch: Fetch, request: JsonRequest = REQUEST) {
    const client = new GeminiClient('test-key', fetch)
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined)
    const error = await client.generateJson(request, 2, 1).then(() => undefined, (err: unknown) => err)
    expect(error).toBeInstanceOf(ModelError)
    return error as ModelError
  }

  it('treats a blocked prompt as a refusal without retrying', async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }))

    const error = await failure(fetch)

    expect(error.message).toBe('Gemini blocked the prompt (blockReason PROHIBITED_CONTENT)')
    expect(error.failure).toEqual({ kind: 'refusal' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('treats every safety-style finish as a refusal, even with partial text', async () => {
    for (const finishReason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']) {
      const fetch = vi.fn<Fetch>(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason }] }))

      const error = await failure(fetch)

      expect(error.message).toBe(`Gemini declined to answer (finishReason ${finishReason})`)
      expect(error.failure).toEqual({ kind: 'refusal' })
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it('treats a MAX_TOKENS finish as truncated output without retrying', async () => {
    const fetch = vi.fn<Fetch>(async () => jsonResponse({ candidates: [{ content: { parts: [{ text: '{"summary":"cut' }] }, finishReason: 'MAX_TOKENS' }] }))

    const error = await failure(fetch)

    expect(error.message).toBe('Gemini stopped at the output token limit (finishReason MAX_TOKENS)')
    expect(error.failure).toEqual({ kind: 'truncated' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('fails fast on a bad key or an unknown model', async () => {
    const badKey = vi.fn<Fetch>(async () => errorResponse(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }))
    const unknownModel = vi.fn<Fetch>(async () => errorResponse(404, { error: { code: 404, message: 'models/m is not found for API version v1beta', status: 'NOT_FOUND' } }))

    expect((await failure(badKey)).failure).toEqual({ kind: 'fatal', cause: 'auth' })
    expect((await failure(unknownModel)).failure).toEqual({ kind: 'fatal', cause: 'model' })
    expect(badKey).toHaveBeenCalledOnce()
    expect(unknownModel).toHaveBeenCalledOnce()
  })

  // The cache may have expired during a long backlog run, which says nothing about the key or the model.
  it('fails only the item on a 403 or 404 from a cached call', async () => {
    const cached: JsonRequest = { ...REQUEST, cacheName: 'cachedContents/abc', useFlexTier: true }
    for (const status of [403, 404]) {
      const fetch = vi.fn<Fetch>(async () => errorResponse(status, { error: { code: status, message: 'CachedContent not found (or permission denied)' } }))

      const error = await failure(fetch, cached)

      expect(error.message).toBe(`{"error":{"code":${status},"message":"CachedContent not found (or permission denied)"}}`)
      expect(error.failure).toEqual({ kind: 'permanent' })
      expect(fetch).toHaveBeenCalledOnce()
    }
  })

  it('keeps a bad key fatal on a cached call', async () => {
    const fetch = vi.fn<Fetch>(async () => errorResponse(401, { error: { code: 401, message: 'unauthenticated' } }))

    expect((await failure(fetch, { ...REQUEST, cacheName: 'cachedContents/abc' })).failure).toEqual({ kind: 'fatal', cause: 'auth' })
  })
})

describe('Gemini model names', () => {
  it('passes models/ and tunedModels/ names through and prefixes any other name', () => {
    expect(geminiModelPath('gemini-3.5-flash-lite')).toBe('models/gemini-3.5-flash-lite')
    expect(geminiModelPath('models/gemini-3.5-flash-lite')).toBe('models/gemini-3.5-flash-lite')
    expect(geminiModelPath('tunedModels/triage')).toBe('tunedModels/triage')
  })

  it('rejects names that could change the request URL', async () => {
    for (const model of ['../files', 'm?alt=sse', 'm&key=x']) {
      expect(() => geminiModelPath(model)).toThrow('invalid model parameter')
    }
    expect(() => geminiModelPath('')).toThrow('model is required')

    // The check runs inside each attempt, so the call fails without sending anything.
    const { client, fetch } = makeClient(reply({ text: '{}' }))
    await expect(client.generateJson({ ...REQUEST, model: '../files' }, 0, 1)).rejects.toThrow('invalid model parameter')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('GeminiClient context caches', () => {
  it('creates a one-hour cache holding the system prompt', async () => {
    const { client, fetch } = makeClient({ name: 'cachedContents/abc', usageMetadata: { totalTokenCount: 4096 } })

    const info = await client.createCache('gemini-pro', 'system prompt', 'autotriage-pro-o/r')

    expect(info).toEqual({ name: 'cachedContents/abc', tokenCount: 4096 })
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/v1beta\/cachedContents$/)
    expect(sentBody(fetch)).toEqual({
      model: 'models/gemini-pro',
      ttl: '3600s',
      displayName: 'autotriage-pro-o/r',
      systemInstruction: { parts: [{ text: 'system prompt' }], role: 'user' },
    })
  })

  it('fails cache creation when the API returns no cache name', async () => {
    const { client } = makeClient({})

    await expect(client.createCache('gemini-pro', 'system prompt')).rejects.toBeInstanceOf(GeminiResponseError)
  })

  it('treats cache deletion as best effort', async () => {
    const { client, fetch } = makeClient(new Error('already expired'))

    await expect(client.deleteCache('cachedContents/abc')).resolves.toBeUndefined()
    expect(String(fetch.mock.calls[0]![0])).toMatch(/\/v1beta\/cachedContents\/abc$/)
    expect(fetch.mock.calls[0]![1]?.method).toBe('DELETE')
  })
})
