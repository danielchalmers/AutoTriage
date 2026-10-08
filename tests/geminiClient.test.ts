import { describe, it, expect, vi } from 'vitest'
import { GeminiClient, GeminiResponseError, geminiModelPath } from '../src/llm/gemini'
import type { Fetch } from '../src/llm/transport'
import type { JsonRequest } from '../src/llm/types'

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
