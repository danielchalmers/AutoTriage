import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { GoogleGenAI, type Fetch } from '@google/genai'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest'
import { buildJsonPayload, createModelFetch, GeminiClient, MODEL_TIMEOUT_MS } from '../src/gemini'
import { errorMessage } from '../src/util'

// Node's real 300s cap is too slow to test, so a local server holds back its headers briefly and the dispatcher gets a shorter timeout instead.
// A request that fails at the short timeout must have gone through the model dispatcher.
// undici only checks this timeout about every half second, so the server waits well past it.
const HEADERS_DELAY_MS = 2000
const SHORT_DISPATCHER_TIMEOUT_MS = 100
const SHORT_DEADLINE_MS = 100

const REPLY = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }

let server: Server
let baseUrl: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    const timer = setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(REPLY))
    }, HEADERS_DELAY_MS)
    res.on('close', () => clearTimeout(timer))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

// Each test starts its short and default requests together, so it waits for the slow server only once.
describe('createModelFetch', () => {
  it('sends requests through its own dispatcher, which waits for slow headers by default', async () => {
    const timedOut = createModelFetch(SHORT_DISPATCHER_TIMEOUT_MS)(baseUrl).catch((err: unknown) => err)
    const completed = createModelFetch()(baseUrl)

    expect(errorMessage(await timedOut)).toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT)')
    expect(await (await completed).json()).toEqual(REPLY)
  })

  // With the dispatcher's timers off, genai's per-attempt deadline is the only limit on a stuck request.
  // genai builds that AbortSignal from Node's built-in undici, so this proves undici's own fetch still honors it.
  // If the signal were ignored, the request would succeed once the slow server answers instead.
  it("aborts at genai's deadline before the server sends headers", async () => {
    const genai = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl, fetch: createModelFetch(), timeout: SHORT_DEADLINE_MS } })

    await expect(genai.models.generateContent(buildJsonPayload('system', 'user', {}, 'm'))).rejects.toMatchObject({ name: 'AbortError' })
  })

  // Node's built-in fetch only honors proxy variables with NODE_USE_ENV_PROXY=1, and model traffic must keep doing the same.
  it('uses the proxy from the environment only when NODE_USE_ENV_PROXY=1', async () => {
    const tunnels: string[] = []
    const proxy = createServer()
    proxy.on('connect', (req, socket) => {
      tunnels.push(req.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))

    try {
      vi.stubEnv('http_proxy', `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`)
      vi.stubEnv('no_proxy', '')
      vi.stubEnv('NODE_USE_ENV_PROXY', '1')
      const proxied = createModelFetch()(baseUrl)
      vi.stubEnv('NODE_USE_ENV_PROXY', '')
      const direct = createModelFetch()(baseUrl)

      await expect(proxied).rejects.toThrow('fetch failed')
      expect(tunnels).toEqual([new URL(baseUrl).host])
      expect(await (await direct).json()).toEqual(REPLY)
      expect(tunnels).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
      proxy.close()
    }
  })
})

describe('GeminiClient transport', () => {
  // genai reads its base URL from the environment, so no request can reach the real API even if the client stops using the given fetch.
  beforeEach(() => {
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', baseUrl)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends flex calls through the model dispatcher', async () => {
    const flexPayload = buildJsonPayload('system', 'user', {}, 'm', undefined, true)

    const timedOut = new GeminiClient('test-key', createModelFetch(SHORT_DISPATCHER_TIMEOUT_MS)).generateJson(flexPayload, 0, 1)
    const completed = new GeminiClient('test-key').generateJson(flexPayload, 0, 1)

    await expect(timedOut).rejects.toThrow('fetch failed (UND_ERR_HEADERS_TIMEOUT)')
    expect((await completed).data).toEqual({ ok: true })
  })

  it('gives every request the model fetch and deadline', async () => {
    const fetch = vi.fn<Fetch>(async (input) =>
      new Response(JSON.stringify(String(input).includes('cachedContents') ? { name: 'cachedContents/abc' } : REPLY))
    )
    const client = new GeminiClient('test-key', fetch)

    await client.generateJson(buildJsonPayload('system', 'user', {}, 'm'), 0, 1)
    await client.generateJson(buildJsonPayload('system', 'user', {}, 'm', 'cachedContents/abc', true), 0, 1)
    await client.createCache('m', 'system')
    await client.deleteCache('cachedContents/abc')

    expect(fetch).toHaveBeenCalledTimes(4)
    for (const [, init] of fetch.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(new Headers(init?.headers).get('x-server-timeout')).toBe(String(MODEL_TIMEOUT_MS / 1000))
    }
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ service_tier: 'flex' })
  })
})
