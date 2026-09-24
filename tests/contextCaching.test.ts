import { ThinkingLevel } from '@google/genai'
import { describe, it, expect } from 'vitest'
import { buildJsonPayload } from '../src/gemini'
import { buildSystemPrompt, buildUserPrompt, type FastPassPlan } from '../src/analysis'
import { makeIssue, withTempFiles } from './fixtures'

describe('context caching', () => {
  describe('buildJsonPayload with caching', () => {
    const systemPrompt = 'You are a triage assistant.'
    const userPrompt = 'Analyze this issue.'
    const schema = { type: 'OBJECT', properties: { summary: { type: 'STRING' } }, required: ['summary'] }
    const model = 'gemini-3.5-flash-lite'

    it('uses systemInstruction when no cache name is provided', () => {
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model)
      expect(payload.config?.systemInstruction).toBe(systemPrompt)
      expect(payload.config?.cachedContent).toBeUndefined()
      expect(payload.config?.httpOptions).toBeUndefined()
    })

    it('uses cachedContent and omits systemInstruction when cache name is provided', () => {
      const cacheName = 'cachedContents/abc123'
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, cacheName)
      expect(payload.config?.cachedContent).toBe(cacheName)
      expect(payload.config?.systemInstruction).toBeUndefined()
    })

    it('preserves other config settings when using cache', () => {
      const cacheName = 'cachedContents/abc123'
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, cacheName)
      expect(payload.config?.cachedContent).toBe(cacheName)
      expect(payload.config?.temperature).toBeUndefined()
      expect(payload.config?.responseMimeType).toBe('application/json')
      expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: ThinkingLevel.HIGH })
    })

    it('still includes user content in both cached and uncached modes', () => {
      const uncachedPayload = buildJsonPayload(systemPrompt, userPrompt, schema, model)
      const cachedPayload = buildJsonPayload(systemPrompt, userPrompt, schema, model, 'cachedContents/abc123')

      expect(uncachedPayload.contents).toEqual(cachedPayload.contents)
      expect(uncachedPayload.contents).toEqual([{
        role: 'user',
        parts: [{ text: userPrompt }],
      }])
    })

    it('opts into flex service tier with long timeout when enabled', () => {
      const cacheName = 'cachedContents/abc123'
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, cacheName, true)
      expect(payload.config?.httpOptions?.headers).toEqual({})
      expect(payload.config?.httpOptions?.timeout).toBe(600000)
      expect(payload.config?.httpOptions?.extraBody).toEqual({ service_tier: 'flex' })
    })
  })

  describe('buildSystemPrompt', () => {
    it('builds system prompt with repo labels and README', () => {
      withTempFiles(
        { 'prompt.txt': 'Test behavior policy', 'readme.md': '# Test readme section' },
        (file) => {
          const repoLabels = [
            { name: 'bug', description: 'Something is broken' },
            { name: 'enhancement', description: 'New feature' },
          ]
          const systemPrompt = buildSystemPrompt(file('prompt.txt'), file('readme.md'), repoLabels)

          expect(systemPrompt).toContain('Test behavior policy')
          expect(systemPrompt).toContain('=== SECTION: REPOSITORY LABELS (JSON) ===')
          expect(systemPrompt).toContain('"bug"')
          expect(systemPrompt).toContain('"enhancement"')
          expect(systemPrompt).toContain('=== SECTION: PROJECT README (MARKDOWN) ===')
          expect(systemPrompt).toContain('# Test readme section')
        }
      )
    })

    it('omits the README from fast-pass system prompts', () => {
      withTempFiles(
        { 'prompt.txt': 'Test behavior policy', 'readme.md': '# README should be omitted' },
        (file) => {
          const repoLabels = [{ name: 'bug', description: null }]
          const systemPrompt = buildSystemPrompt(file('prompt.txt'), file('readme.md'), repoLabels, undefined, 'fast', { readmeChars: 0 })
          expect(systemPrompt).not.toContain('=== SECTION: PROJECT README (MARKDOWN) ===')
          expect(systemPrompt).not.toContain('README should be omitted')
        }
      )
    })

    it('clamps the README to the pass readme budget', () => {
      withTempFiles(
        { 'prompt.txt': 'Test behavior policy', 'readme.md': '# Title\nLong readme body' },
        (file) => {
          const systemPrompt = buildSystemPrompt(file('prompt.txt'), file('readme.md'), [], undefined, 'pro', { readmeChars: 7 })
          expect(systemPrompt).toContain('=== SECTION: PROJECT README (MARKDOWN) ===\n# Title\n')
          expect(systemPrompt).not.toContain('Long readme body')
        }
      )
    })

    it('sorts repository labels for stable cache keys', () => {
      withTempFiles({ 'prompt.txt': 'Stable prompt' }, (file) => {
        const labelsA = [
          { name: 'zeta', description: null },
          { name: 'alpha', description: 'First' },
        ]
        const labelsB = [
          { name: 'alpha', description: 'First' },
          { name: 'zeta', description: null },
        ]
        const promptA = buildSystemPrompt(file('prompt.txt'), '', labelsA)
        const promptB = buildSystemPrompt(file('prompt.txt'), '', labelsB)
        expect(promptA).toBe(promptB)
        expect(promptA.indexOf('"alpha"')).toBeLessThan(promptA.indexOf('"zeta"'))
      })
    })
  })

  describe('buildUserPrompt', () => {
    it('includes issue-specific content', () => {
      const issue = makeIssue(42, undefined, { title: 'Test issue', body: 'Body text' })

      const timelineEvents = [
        { event: 'commented', body: 'A comment', created_at: '2024-01-01T00:00:00Z' },
      ] as any[]

      const userPrompt = buildUserPrompt(issue, timelineEvents, 'pro', undefined, 'This item was triaged before at 2024-01-01T00:00:00Z and is being checked again.')

      expect(userPrompt).toContain('Test issue')
      expect(userPrompt).toContain('A comment')
      expect(userPrompt).toContain('=== SECTION: RUNTIME CONTEXT ===')
      expect(userPrompt).toContain('Reason this run is happening: This item was triaged before at 2024-01-01T00:00:00Z and is being checked again.')
      expect(userPrompt).toContain('=== SECTION: ISSUE METADATA (JSON) ===')
      expect(userPrompt).toContain('=== SECTION: ISSUE TIMELINE EVENTS (JSON) ===')
    })

    it('does not contain static repo content', () => {
      const issue = makeIssue(1, undefined, { title: 'Issue', body: '' })

      const userPrompt = buildUserPrompt(issue, [])

      expect(userPrompt).not.toContain('=== SECTION: REPOSITORY LABELS')
      expect(userPrompt).not.toContain('=== SECTION: PROJECT README')
      expect(userPrompt).not.toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY')
    })

    it('applies pass-specific limits to the issue body and timeline', () => {
      const issue = makeIssue(2, undefined, { title: 'Issue', body: 'x'.repeat(20) })

      const timelineEvents = [
        { event: 'commented', body: 'a'.repeat(20), created_at: '2024-01-01T00:00:00Z' },
        { event: 'committed', message: 'b'.repeat(20), created_at: '2024-01-02T00:00:00Z' },
        { event: 'reviewed', body: 'c'.repeat(20), created_at: '2024-01-03T00:00:00Z' },
      ] as any[]

      const fastPrompt = buildUserPrompt(issue, timelineEvents, 'fast', {
        issueBodyChars: 5,
        timelineEvents: 2,
        timelineTextChars: 3,
      })
      expect(fastPrompt).toContain('"body": "xxxxx"')
      expect(fastPrompt).toContain('"message": "bbb"')
      expect(fastPrompt).toContain('"body": "ccc"')
      // Only the newest two events fit the fast budget.
      expect(fastPrompt).not.toContain('"event": "commented"')
      expect(fastPrompt).not.toContain('FAST PASS PROPOSED PLAN')

      const proPrompt = buildUserPrompt(issue, timelineEvents, 'pro', {
        issueBodyChars: 50,
        timelineEvents: 3,
        timelineTextChars: 50,
      }, 'Re-check this item because it has new activity since the last triage.')
      expect(proPrompt).toContain('Reason this run is happening: Re-check this item because it has new activity since the last triage.')
      expect(proPrompt).toContain(`"body": "${'x'.repeat(20)}"`)
      expect(proPrompt).toContain(`"body": "${'a'.repeat(20)}"`)
      expect(proPrompt).not.toContain('FAST PASS PROPOSED PLAN')
    })

    it('includes fast pass structured plan only in pro prompts', () => {
      const issue = makeIssue(3, undefined, { title: 'Issue', body: 'Body text' })

      const fastPassPlan: FastPassPlan = {
        analysis: {
          summary: 'Summarized issue',
          operations: [
            { kind: 'add_labels', labels: ['bug'], authorization: 'policy allows bug label' },
            { kind: 'comment', body: 'Need follow-up', authorization: 'policy requires follow-up' },
          ],
        },
        operations: [
          { kind: 'add_labels', labels: ['bug'], authorization: 'policy allows bug label' },
          { kind: 'comment', body: 'Need follow-up', authorization: 'policy requires follow-up' },
        ],
      }

      const proPrompt = buildUserPrompt(
        issue,
        [],
        'pro',
        undefined,
        'Re-checking this item after fast pass.',
        fastPassPlan,
      )

      expect(proPrompt).toContain('=== SECTION: FAST PASS PROPOSED PLAN (JSON) ===')
      expect(proPrompt).toContain('The following plan was produced by a faster preliminary model.')
      expect(proPrompt).toContain('"summary": "Summarized issue"')
      expect(proPrompt).toContain('"kind": "add_labels"')
      expect(proPrompt).toContain('"kind": "comment"')

      const fastPrompt = buildUserPrompt(issue, [], 'fast', undefined, undefined, fastPassPlan)
      expect(fastPrompt).not.toContain('FAST PASS PROPOSED PLAN')
    })

    it('uses a provided run timestamp instead of generating a per-prompt timestamp', () => {
      const issue = makeIssue(5, undefined, { title: 'Issue', body: 'Body text' })

      const runTimestamp = '2026-04-24T12:00:00.000Z'
      const proPrompt = buildUserPrompt(issue, [], 'pro', undefined, undefined, undefined, runTimestamp)

      expect(proPrompt).toContain(`Current date/time (UTC ISO 8601): ${runTimestamp}`)
    })
  })
})
