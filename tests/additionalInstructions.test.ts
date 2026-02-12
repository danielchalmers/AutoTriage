import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../src/analysis'
import type { Issue, TimelineEvent } from '../src/github'
import * as fs from 'fs'
import * as path from 'path'

describe('additional instructions', () => {
  const mockIssue: Issue = {
    title: 'Test Issue',
    state: 'open',
    type: 'issue',
    number: 123,
    author: 'testuser',
    user_type: 'User',
    draft: false,
    locked: false,
    milestone: null,
    comments: 0,
    reactions: 0,
    labels: [],
    assignees: [],
    body: 'This is a test issue',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const mockTimelineEvents: TimelineEvent[] = []
  const mockRepoLabels = [
    { name: 'bug', description: 'Something is broken' },
    { name: 'enhancement', description: 'New feature' },
  ]

  it('includes additional instructions in the system prompt when provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const additionalInstructions = 'Always add the "urgent" label to issues'
      const { systemPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        undefined,
        mockRepoLabels,
        '',
        additionalInstructions
      )

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).toContain('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
      expect(systemPrompt).toContain(additionalInstructions)
      
      // Verify additional instructions appear between ASSISTANT BEHAVIOR POLICY and RUNTIME CONTEXT
      const policyIndex = systemPrompt.indexOf('=== SECTION: ASSISTANT BEHAVIOR POLICY ===')
      const additionalIndex = systemPrompt.indexOf('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
      const runtimeIndex = systemPrompt.indexOf('=== SECTION: RUNTIME CONTEXT ===')
      
      expect(policyIndex).toBeGreaterThan(-1)
      expect(additionalIndex).toBeGreaterThan(-1)
      expect(runtimeIndex).toBeGreaterThan(-1)
      expect(additionalIndex).toBeGreaterThan(policyIndex)
      expect(runtimeIndex).toBeGreaterThan(additionalIndex)
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

  it('does not include additional instructions section when not provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { systemPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        undefined,
        mockRepoLabels,
        '',
        undefined
      )

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).not.toContain('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

  it('does not include additional instructions section when empty string provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { systemPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        '',
        mockTimelineEvents,
        undefined,
        mockRepoLabels,
        '',
        ''
      )

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).not.toContain('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })
})
