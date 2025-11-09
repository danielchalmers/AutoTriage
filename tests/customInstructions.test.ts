import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../src/analysis'
import type { Issue, TimelineEvent } from '../src/github'
import * as fs from 'fs'
import * as path from 'path'

describe('custom instructions', () => {
  const mockIssue: Issue = {
    number: 123,
    title: 'Test Issue',
    body: 'This is a test issue',
    state: 'open',
    user: { login: 'testuser', type: 'User' },
    labels: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    html_url: 'https://github.com/test/repo/issues/123',
    pull_request: undefined,
  }

  const mockTimelineEvents: TimelineEvent[] = []
  const mockRepoLabels = [
    { name: 'bug', description: 'Something is broken' },
    { name: 'enhancement', description: 'New feature' },
  ]

  it('includes custom instructions in the system prompt when provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const customInstructions = 'Always add the "urgent" label to issues'
      const { systemPrompt, userPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        mockRepoLabels,
        '',
        customInstructions
      )

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).toContain('=== SECTION: CUSTOM INSTRUCTIONS ===')
      expect(systemPrompt).toContain(customInstructions)
      
      // Verify custom instructions appear between ASSISTANT BEHAVIOR POLICY and RUNTIME CONTEXT
      const policyIndex = systemPrompt.indexOf('=== SECTION: ASSISTANT BEHAVIOR POLICY ===')
      const customIndex = systemPrompt.indexOf('=== SECTION: CUSTOM INSTRUCTIONS ===')
      const runtimeIndex = systemPrompt.indexOf('=== SECTION: RUNTIME CONTEXT ===')
      
      expect(policyIndex).toBeGreaterThan(-1)
      expect(customIndex).toBeGreaterThan(-1)
      expect(runtimeIndex).toBeGreaterThan(-1)
      expect(customIndex).toBeGreaterThan(policyIndex)
      expect(runtimeIndex).toBeGreaterThan(customIndex)
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

  it('does not include custom instructions section when not provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { systemPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        mockRepoLabels,
        '',
        undefined
      )

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).not.toContain('=== SECTION: CUSTOM INSTRUCTIONS ===')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

  it('does not include custom instructions section when empty string provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { systemPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        mockRepoLabels,
        '',
        ''
      )

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).not.toContain('=== SECTION: CUSTOM INSTRUCTIONS ===')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })
})
