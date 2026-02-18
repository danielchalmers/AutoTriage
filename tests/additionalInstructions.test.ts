import { describe, it, expect } from 'vitest'
import { buildPrompt } from '../src/analysis'
import type { Issue, TimelineEvent } from '../src/github'
import * as fs from 'fs'
import * as path from 'path'

describe('additional instructions', () => {
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

  it('omits README section when includeReadme is false', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const { userPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        path.join(__dirname, 'README.md'),
        mockTimelineEvents,
        mockRepoLabels,
        '',
        undefined,
        false
      )

      expect(userPrompt).not.toContain('=== SECTION: PROJECT README (MARKDOWN) ===')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

  it('includes README section when includeReadme is true', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    const readmePath = path.join(__dirname, 'test-README.md')
    fs.writeFileSync(customPromptPath, 'Base prompt content')
    fs.writeFileSync(readmePath, '# Test README')

    try {
      const { userPrompt } = await buildPrompt(
        mockIssue,
        customPromptPath,
        readmePath,
        mockTimelineEvents,
        mockRepoLabels,
        '',
        undefined,
        true
      )

      expect(userPrompt).toContain('=== SECTION: PROJECT README (MARKDOWN) ===')
      expect(userPrompt).toContain('# Test README')
    } finally {
      fs.unlinkSync(customPromptPath)
      fs.unlinkSync(readmePath)
    }
  })
})
