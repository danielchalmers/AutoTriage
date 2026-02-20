import { describe, it, expect } from 'vitest'
import { buildJsonPayload } from '../src/gemini'
import { buildSystemPrompt, buildUserPrompt } from '../src/analysis'
import * as fs from 'fs'
import * as path from 'path'

describe('context caching', () => {
  describe('buildJsonPayload with caching', () => {
    const systemPrompt = 'You are a triage assistant.'
    const userPrompt = 'Analyze this issue.'
    const schema = { type: 'OBJECT', properties: { summary: { type: 'STRING' } }, required: ['summary'] }
    const model = 'gemini-2.5-flash-lite'

    it('uses systemInstruction when no cache name is provided', () => {
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, -1)
      expect(payload.config?.systemInstruction).toBe(systemPrompt)
      expect(payload.config?.cachedContent).toBeUndefined()
    })

    it('uses cachedContent and omits systemInstruction when cache name is provided', () => {
      const cacheName = 'cachedContents/abc123'
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, -1, cacheName)
      expect(payload.config?.cachedContent).toBe(cacheName)
      expect(payload.config?.systemInstruction).toBeUndefined()
    })

    it('preserves other config settings when using cache', () => {
      const cacheName = 'cachedContents/abc123'
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, model, 1024, cacheName)
      expect(payload.config?.cachedContent).toBe(cacheName)
      expect(payload.config?.temperature).toBe(0)
      expect(payload.config?.responseMimeType).toBe('application/json')
      expect(payload.config?.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 })
    })

    it('still includes user content in both cached and uncached modes', () => {
      const uncachedPayload = buildJsonPayload(systemPrompt, userPrompt, schema, model, -1)
      const cachedPayload = buildJsonPayload(systemPrompt, userPrompt, schema, model, -1, 'cachedContents/abc123')

      expect(uncachedPayload.contents).toEqual(cachedPayload.contents)
      expect(uncachedPayload.contents?.[0]).toEqual({
        role: 'user',
        parts: [{ text: userPrompt }],
      })
    })

    it('omits temperature for non gemini-2 models', () => {
      const payload = buildJsonPayload(systemPrompt, userPrompt, schema, 'gemini-3-flash-preview', -1)
      expect(payload.config?.temperature).toBeUndefined()
    })
  })

  describe('buildSystemPrompt', () => {
    it('builds system prompt with repo labels and README', () => {
      const customPromptPath = path.join(__dirname, 'test-cache-prompt.txt')
      const readmePath = path.join(__dirname, 'test-cache-readme.md')
      fs.writeFileSync(customPromptPath, 'Test behavior policy')
      fs.writeFileSync(readmePath, '# Test readme section')

      try {
        const repoLabels = [
          { name: 'bug', description: 'Something is broken' },
          { name: 'enhancement', description: 'New feature' },
        ]
        const systemPrompt = buildSystemPrompt(customPromptPath, readmePath, repoLabels)
        
        expect(systemPrompt).toContain('Test behavior policy')
        expect(systemPrompt).toContain('=== SECTION: REPOSITORY LABELS (JSON) ===')
        expect(systemPrompt).toContain('"bug"')
        expect(systemPrompt).toContain('"enhancement"')
        expect(systemPrompt).toContain('=== SECTION: PROJECT README (MARKDOWN) ===')
        expect(systemPrompt).toContain('# Test readme section')
      } finally {
        fs.unlinkSync(customPromptPath)
        fs.unlinkSync(readmePath)
      }
    })

    it('omits README section in fast pass by default', () => {
      const customPromptPath = path.join(__dirname, 'test-cache-prompt-fast.txt')
      const readmePath = path.join(__dirname, 'test-cache-readme-fast.md')
      fs.writeFileSync(customPromptPath, 'Test behavior policy')
      fs.writeFileSync(readmePath, '# README should be omitted')

      try {
        const repoLabels = [{ name: 'bug', description: null }]
        const systemPrompt = buildSystemPrompt(customPromptPath, readmePath, repoLabels, undefined, 'fast', { readmeChars: 0 })
        expect(systemPrompt).not.toContain('=== SECTION: PROJECT README (MARKDOWN) ===')
        expect(systemPrompt).not.toContain('README should be omitted')
      } finally {
        fs.unlinkSync(customPromptPath)
        fs.unlinkSync(readmePath)
      }
    })

    it('produces identical output for same inputs (cacheable)', () => {
      const customPromptPath = path.join(__dirname, 'test-cache-prompt2.txt')
      fs.writeFileSync(customPromptPath, 'Stable prompt')

      try {
        const repoLabels = [{ name: 'bug', description: null }]
        const prompt1 = buildSystemPrompt(customPromptPath, '', repoLabels)
        const prompt2 = buildSystemPrompt(customPromptPath, '', repoLabels)
        expect(prompt1).toBe(prompt2)
      } finally {
        fs.unlinkSync(customPromptPath)
      }
    })
  })

  describe('buildUserPrompt', () => {
    it('includes issue-specific content', () => {
      const issue = {
        number: 42,
        title: 'Test issue',
        body: 'Body text',
        state: 'open',
        type: 'issue',
        author: 'testuser',
        user_type: 'User',
        draft: false,
        locked: false,
        milestone: null,
        comments: 0,
        reactions: 0,
        labels: [],
        assignees: [],
      } as any

      const timelineEvents = [
        { event: 'commented', body: 'A comment', created_at: '2024-01-01T00:00:00Z' },
      ] as any[]

      const userPrompt = buildUserPrompt(issue, timelineEvents, 'prior thoughts')

      expect(userPrompt).toContain('Test issue')
      expect(userPrompt).toContain('A comment')
      expect(userPrompt).toContain('prior thoughts')
      expect(userPrompt).toContain('=== SECTION: RUNTIME CONTEXT ===')
      expect(userPrompt).toContain('=== SECTION: ISSUE METADATA (JSON) ===')
      expect(userPrompt).toContain('=== SECTION: ISSUE TIMELINE EVENTS (JSON) ===')
      expect(userPrompt).toContain('=== SECTION: THOUGHTS FROM LAST RUN ===')
    })

    it('does not contain static repo content', () => {
      const issue = {
        number: 1,
        title: 'Issue',
        body: '',
        state: 'open',
        type: 'issue',
        author: 'user',
        user_type: 'User',
        draft: false,
        locked: false,
        milestone: null,
        comments: 0,
        reactions: 0,
        labels: [],
        assignees: [],
      } as any

      const userPrompt = buildUserPrompt(issue, [], '')

      expect(userPrompt).not.toContain('=== SECTION: REPOSITORY LABELS')
      expect(userPrompt).not.toContain('=== SECTION: PROJECT README')
      expect(userPrompt).not.toContain('=== SECTION: ASSISTANT BEHAVIOR POLICY')
    })

    it('uses pass-specific truncation limits and thought gating', () => {
      const issue = {
        number: 2,
        title: 'Issue',
        body: 'x'.repeat(20),
        state: 'open',
        type: 'issue',
        author: 'user',
        user_type: 'User',
        draft: false,
        locked: false,
        milestone: null,
        comments: 0,
        reactions: 0,
        labels: [],
        assignees: [],
      } as any

      const timelineEvents = [
        { event: 'commented', body: 'a'.repeat(20), created_at: '2024-01-01T00:00:00Z' },
        { event: 'committed', message: 'b'.repeat(20), created_at: '2024-01-02T00:00:00Z' },
        { event: 'reviewed', body: 'c'.repeat(20), created_at: '2024-01-03T00:00:00Z' },
      ] as any[]

      const fastPrompt = buildUserPrompt(issue, timelineEvents, 'prior thoughts', 'fast', {
        issueBodyChars: 5,
        timelineEvents: 2,
        timelineTextChars: 3,
      })
      expect(fastPrompt).toContain('"body": "xxxxx"')
      expect(fastPrompt).toContain('"message": "bbb"')
      expect(fastPrompt).toContain('"body": "ccc"')
      expect(fastPrompt).not.toContain('THOUGHTS FROM LAST RUN')

      const proPrompt = buildUserPrompt(issue, timelineEvents, 'prior thoughts', 'pro', {
        issueBodyChars: 50,
        timelineEvents: 3,
        timelineTextChars: 50,
      })
      expect(proPrompt).toContain('=== SECTION: THOUGHTS FROM LAST RUN ===')
      expect(proPrompt).toContain('prior thoughts')
    })
  })
})
