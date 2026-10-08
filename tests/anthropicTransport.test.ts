import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnthropicClient } from '../src/llm/anthropic'
import { ModelError } from '../src/llm/types'

// A local server stands in for the API, so the requests go through the real model fetch and dispatcher.
const REPLY = { content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
const REQUEST = { model: 'claude-haiku-5-5', systemPrompt: 'system', userPrompt: 'user', schema: { type: 'OBJECT', properties: {}, required: [] } }

let server: Server
let baseUrl: string
const paths: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    paths.push(req.url ?? '')
    if (req.url?.startsWith('/moved/')) {
      res.writeHead(307, { location: `${baseUrl}/v1/messages` })
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

describe('AnthropicClient transport', () => {
  it('calls the Messages API through the model fetch', async () => {
    paths.length = 0
    const result = await new AnthropicClient('test-key', undefined, baseUrl).generateJson(REQUEST, 0, 1)

    expect(result.data).toEqual({ ok: true })
    expect(paths).toEqual(['/v1/messages'])
  })

  // The redirect target would receive the key and the prompt, so the request fails instead of following it.
  it('fails a redirected request without following it or retrying', async () => {
    paths.length = 0
    const error = await new AnthropicClient('test-key', undefined, `${baseUrl}/moved`).generateJson(REQUEST, 2, 1).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ModelError)
    expect(error).toMatchObject({
      message: `The model API redirected the request (HTTP 307 to ${baseUrl}/v1/messages), and redirects are not followed because the request carries the API key.`,
      failure: { kind: 'permanent' },
    })
    expect(paths).toEqual(['/moved/v1/messages'])
  })
})
