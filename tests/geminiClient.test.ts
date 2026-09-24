import { describe, it, expect, vi } from 'vitest'
import { GeminiClient, GeminiResponseError } from '../src/gemini'

// Swap in stubs for the SDK surfaces under test and record backoff instead of sleeping.
function makeClient(sdk: { generateContent?: ReturnType<typeof vi.fn>; create?: ReturnType<typeof vi.fn>; delete?: ReturnType<typeof vi.fn> }) {
  const client = new GeminiClient('test-key')
  ;(client as any).client = {
    models: { generateContent: sdk.generateContent },
    caches: { create: sdk.create, delete: sdk.delete },
  }
  vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined)
  return client
}

const PAYLOAD = { model: 'm', contents: [] }

describe('GeminiClient.generateJson response parsing', () => {
  it('separates thought parts from the JSON answer and reports token usage', async () => {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{
        content: {
          parts: [
            { text: 'First thought.\n\n\n', thought: true },
            { text: '{"summary":' },
            { text: 'Second thought.', thought: true },
            { text: '"ok","operations":[]}' },
            { inlineData: {} },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 800, candidatesTokenCount: 50, thoughtsTokenCount: 400 },
    })

    const result = await makeClient({ generateContent }).generateJson(PAYLOAD, 2, 1)

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
    const generateContent = vi.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ text: '{}' }] } }] })

    const result = await makeClient({ generateContent }).generateJson(PAYLOAD, 0, 1)

    expect(result).toMatchObject({ thoughts: '', inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, thoughtsTokens: 0 })
  })

  it('retries malformed JSON and reports a parse error once retries run out', async () => {
    const generateContent = vi.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ text: '{"summary": ' }] } }] })

    await expect(makeClient({ generateContent }).generateJson(PAYLOAD, 1, 1)).rejects.toThrow('Unable to parse JSON from Gemini response')
    expect(generateContent).toHaveBeenCalledTimes(2)
  })

  it('treats a response with only thoughts as empty', async () => {
    const generateContent = vi.fn().mockResolvedValue({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] } }] })

    await expect(makeClient({ generateContent }).generateJson(PAYLOAD, 0, 1)).rejects.toThrow('Gemini responded with empty text')
  })
})

describe('GeminiClient context caches', () => {
  it('creates a one-hour cache holding the system prompt', async () => {
    const create = vi.fn().mockResolvedValue({ name: 'cachedContents/abc', usageMetadata: { totalTokenCount: 4096 } })

    const info = await makeClient({ create }).createCache('gemini-pro', 'system prompt', 'autotriage-pro-o/r')

    expect(info).toEqual({ name: 'cachedContents/abc', tokenCount: 4096 })
    expect(create).toHaveBeenCalledWith({
      model: 'gemini-pro',
      config: { displayName: 'autotriage-pro-o/r', systemInstruction: 'system prompt', ttl: '3600s' },
    })
  })

  it('fails cache creation when the API returns no cache name', async () => {
    const create = vi.fn().mockResolvedValue({})

    await expect(makeClient({ create }).createCache('gemini-pro', 'system prompt')).rejects.toBeInstanceOf(GeminiResponseError)
  })

  it('treats cache deletion as best effort', async () => {
    const del = vi.fn().mockRejectedValue(new Error('already expired'))

    await expect(makeClient({ delete: del }).deleteCache('cachedContents/abc')).resolves.toBeUndefined()
    expect(del).toHaveBeenCalledWith({ name: 'cachedContents/abc' })
  })
})
