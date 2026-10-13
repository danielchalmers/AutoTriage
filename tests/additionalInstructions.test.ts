import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../src/prompts'
import { makeConfig } from './fixtures'

describe('additional instructions', () => {
  const mockRepoLabels = [
    { name: 'bug', description: 'Something is broken' },
    { name: 'enhancement', description: 'New feature' },
  ]
  const { limits } = makeConfig()

  it('includes additional instructions in the system prompt when provided', () => {
    const additionalInstructions = 'Always add the "urgent" label to issues'
    const systemPrompt = buildSystemPrompt('Base prompt content', '', mockRepoLabels, additionalInstructions, limits)

    expect(systemPrompt).toContain('Base prompt content')
    expect(systemPrompt).toContain(additionalInstructions)

    // Verify additional instructions appear between ASSISTANT BEHAVIOR POLICY and REPOSITORY LABELS
    const policyIndex = systemPrompt.indexOf('=== SECTION: ASSISTANT BEHAVIOR POLICY ===')
    const additionalIndex = systemPrompt.indexOf('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
    const labelsIndex = systemPrompt.indexOf('=== SECTION: REPOSITORY LABELS (JSON) ===')

    expect(policyIndex).toBeGreaterThan(-1)
    expect(additionalIndex).toBeGreaterThan(policyIndex)
    expect(labelsIndex).toBeGreaterThan(additionalIndex)
  })

  it('does not include additional instructions section when not provided', () => {
    const systemPrompt = buildSystemPrompt('Base prompt content', '', mockRepoLabels, undefined, limits)

    expect(systemPrompt).toContain('Base prompt content')
    expect(systemPrompt).not.toContain('=== SECTION: ADDITIONAL INSTRUCTIONS ===')
  })
})
