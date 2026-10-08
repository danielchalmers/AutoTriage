import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIClient } from '../src/llm/openai'
import { ModelError } from '../src/llm/types'

// A local server stands in for an OpenAI-compatible service, so the requests go through the real model fetch and dispatcher.
const REPLY = { choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
const REQUEST = { model: 'llama4', systemPrompt: 'system', userPrompt: 'user', schema: { type: 'OBJECT', properties: {}, required: [] } }

let server: Server
let baseUrl: string
const requests: Array<{ path: string; headers: IncomingHttpHeaders }> = []

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers })
    if (req.url?.startsWith('/moved/')) {
      res.writeHead(308, { location: `${baseUrl}/v1/chat/completions` })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(REPLY))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

beforeEach(() => {
  requests.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenAIClient transport', () => {
  it('calls Chat Completions through the model fetch, without an Authorization header when there is no key', async () => {
    const result = await new OpenAIClient(undefined, undefined, `${baseUrl}/v1`).generateJson(REQUEST, 0, 1)

    expect(result.data).toEqual({ ok: true })
    expect(requests.map(request => request.path)).toEqual(['/v1/chat/completions'])
    expect(requests[0]!.headers.authorization).toBeUndefined()
  })

  it('sends the key as a Bearer token', async () => {
    await new OpenAIClient('test-key', undefined, `${baseUrl}/v1`).generateText(REQUEST, 0, 1)

    expect(requests[0]!.headers.authorization).toBe('Bearer test-key')
  })

  // The redirect target would receive the key and the issue text, so the request fails instead of following it.
  it('fails a redirected request without following it or retrying', async () => {
    const error = await new OpenAIClient('test-key', undefined, `${baseUrl}/moved/v1`).generateJson(REQUEST, 2, 1).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({
      message: `The model API redirected the request (HTTP 308 to ${baseUrl}/v1/chat/completions), and redirects are not followed because the request carries the API key.`,
      failure: { kind: 'permanent' },
    })
    expect(requests.map(request => request.path)).toEqual(['/moved/v1/chat/completions'])
  })
})
