import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/analysis'
import * as fs from 'fs'
import * as path from 'path'

describe('additional instructions', () => {
  const mockRepoLabels = [
    { name: 'bug', description: 'Something is broken' },
    { name: 'enhancement', description: 'New feature' },
  ]

  it('includes additional instructions in the system prompt when provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const additionalInstructions = 'Always add the "urgent" label to issues'
      const systemPrompt = buildSystemPrompt(customPromptPath, '', mockRepoLabels, additionalInstructions)

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).toContain('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
      expect(systemPrompt).toContain(additionalInstructions)
      
      // Verify additional instructions appear between ASSISTANT BEHAVIOR POLICY and REPOSITORY LABELS
      const policyIndex = systemPrompt.indexOf('=== SECTION: ASSISTANT BEHAVIOR POLICY ===')
      const additionalIndex = systemPrompt.indexOf('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
      const labelsIndex = systemPrompt.indexOf('=== SECTION: REPOSITORY LABELS (JSON) ===')
      
      expect(policyIndex).toBeGreaterThan(-1)
      expect(additionalIndex).toBeGreaterThan(-1)
      expect(labelsIndex).toBeGreaterThan(-1)
      expect(additionalIndex).toBeGreaterThan(policyIndex)
      expect(labelsIndex).toBeGreaterThan(additionalIndex)
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

  it('does not include additional instructions section when not provided', async () => {
    const customPromptPath = path.join(__dirname, 'test-custom-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Base prompt content')

    try {
      const systemPrompt = buildSystemPrompt(customPromptPath, '', mockRepoLabels, undefined)

      expect(systemPrompt).toContain('Base prompt content')
      expect(systemPrompt).not.toContain('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
  })

})
