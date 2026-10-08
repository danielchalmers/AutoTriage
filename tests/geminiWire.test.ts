import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Fetch } from '@google/genai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAnalysisResultSchema } from '../src/analysis'
import { buildJsonPayload, GeminiClient } from '../src/gemini'

// Both fixtures were recorded from the @google/genai client before it was replaced (#178).
// A workflow that only sets GEMINI_API_KEY must keep sending these exact requests and reading these exact results, so neither fixture is edited to make a change pass.
const REQUESTS_FIXTURE = path.join(__dirname, 'fixtures', 'gemini-requests.json')
const RESPONSES_FIXTURE = path.join(__dirname, 'fixtures', 'gemini-responses.json')

// Non-ASCII text and quotes make sure the body is serialized the same way, not just shaped the same way.
const SYSTEM_PROMPT = 'You are a triage assistant.\nFollow the "policy" below.'
const USER_PROMPT = 'Triage #42: Crash on save — naïve café 🚀\n{"title":"Crash"}'
const LABELS = [{ name: 'enhancement' }, { name: 'bug' }, { name: 'breaking change' }]
const CACHE_NAME = 'cachedContents/abc123'
const REPLY = { candidates: [{ content: { parts: [{ text: '{"summary":"ok","operations":[]}' }] } }] }

interface RecordedRequest {
  method: string
  url: string
  headers: Record<'x-goog-api-key' | 'x-server-timeout' | 'content-type', string | null>
  body: string | null
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

// Records each request and answers it the way the Gemini API would, so no request leaves the process.
function recordingFetch(requests: RecordedRequest[]): Fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    const url = String(input)
    requests.push({
      method: init?.method ?? 'GET',
      url,
      headers: {
        'x-goog-api-key': headers.get('x-goog-api-key'),
        'x-server-timeout': headers.get('x-server-timeout'),
        'content-type': headers.get('content-type'),
      },
      body: typeof init?.body === 'string' ? init.body : null,
    })
    if (init?.method === 'DELETE') return jsonResponse({})
    if (url.endsWith('/cachedContents')) return jsonResponse({ name: CACHE_NAME, usageMetadata: { totalTokenCount: 4096 } })
    return jsonResponse(REPLY)
  }
}

// Each call the action makes, named as it appears in the fixture.
const REQUEST_CASES: Record<string, (client: GeminiClient) => Promise<unknown>> = {
  'generate with labels': client =>
    client.generateJson(buildJsonPayload(SYSTEM_PROMPT, USER_PROMPT, buildAnalysisResultSchema(LABELS), 'gemini-3.5-flash-lite'), 0, 1),
  'generate without labels': client =>
    client.generateJson(buildJsonPayload(SYSTEM_PROMPT, USER_PROMPT, buildAnalysisResultSchema([]), 'gemini-3.5-flash-lite'), 0, 1),
  'generate cached on the flex tier': client =>
    client.generateJson(buildJsonPayload(SYSTEM_PROMPT, USER_PROMPT, buildAnalysisResultSchema(LABELS), 'gemini-3.8-flash', CACHE_NAME, true), 0, 1),
  'generate with a models/ name': client =>
    client.generateJson(buildJsonPayload(SYSTEM_PROMPT, USER_PROMPT, buildAnalysisResultSchema(LABELS), 'models/gemini-3.5-flash-lite'), 0, 1),
  'generate with a tunedModels/ name': client =>
    client.generateJson(buildJsonPayload(SYSTEM_PROMPT, USER_PROMPT, buildAnalysisResultSchema(LABELS), 'tunedModels/triage-tuned'), 0, 1),
  'create cache': client => client.createCache('gemini-3.8-flash', SYSTEM_PROMPT, 'autotriage-pro-owner/repo'),
  'delete cache': client => client.deleteCache(CACHE_NAME),
}

interface CannedResponse {
  status: number
  statusText: string
  contentType: string
  body: string
}

interface ResponseCase {
  call: 'generateJson' | 'createCache'
  response: CannedResponse
  outcome: { result: unknown } | { error: { message: string; status: number | null } }
}

function readFixture<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

beforeEach(() => {
  // Requests must not depend on the runner's environment.
  vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
  vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Gemini requests', () => {
  it('sends the recorded request for every call', async () => {
    const recorded: Record<string, RecordedRequest> = {}
    for (const [name, call] of Object.entries(REQUEST_CASES)) {
      const requests: RecordedRequest[] = []
      await call(new GeminiClient('test-key', recordingFetch(requests)))
      expect(requests, name).toHaveLength(1)
      recorded[name] = requests[0]!
    }

    expect(recorded).toEqual(readFixture(REQUESTS_FIXTURE))
  })
})

describe('Gemini responses', () => {
  it('reads every recorded response the same way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cases = readFixture<Record<string, ResponseCase>>(RESPONSES_FIXTURE)
    const outcomes: Record<string, ResponseCase['outcome']> = {}

    for (const [name, { call, response }] of Object.entries(cases)) {
      // A fresh response per attempt, because capacity errors are retried and a body can only be read once.
      const fetch: Fetch = async () =>
        new Response(response.body, { status: response.status, statusText: response.statusText, headers: { 'content-type': response.contentType } })
      const client = new GeminiClient('test-key', fetch)
      vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined)

      try {
        const result = call === 'createCache'
          ? await client.createCache('gemini-3.8-flash', SYSTEM_PROMPT)
          : await client.generateJson(buildJsonPayload(SYSTEM_PROMPT, USER_PROMPT, buildAnalysisResultSchema([]), 'gemini-3.5-flash-lite'), 0, 1)
        outcomes[name] = { result }
      } catch (err) {
        const status = (err as { status?: unknown }).status
        outcomes[name] = { error: { message: (err as Error).message, status: typeof status === 'number' ? status : null } }
      }
    }

    expect(outcomes).toEqual(Object.fromEntries(Object.entries(cases).map(([name, { outcome }]) => [name, outcome])))
  })
})
