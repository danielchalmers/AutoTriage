import { describe, it, expect } from 'vitest'
import { readWorkspaceFile } from '../src/storage'
import { BUILTIN_LABEL_ONLY_PROMPT, buildSystemPrompt } from '../src/prompts'
import { makeConfig } from './fixtures'
import { withTempFiles } from './fixtures'
import * as path from 'path'

describe('readWorkspaceFile', () => {
  it('reads a file, or returns undefined when the workspace lacks it or it is a directory', () => {
    withTempFiles({ 'prompt.txt': 'Custom test prompt' }, (file) => {
      expect(readWorkspaceFile(file('prompt.txt'))).toBe('Custom test prompt')
    })
    expect(readWorkspaceFile(path.join(__dirname, 'does-not-exist.txt'))).toBeUndefined()
    expect(readWorkspaceFile(__dirname)).toBeUndefined()
  })
})

describe('built-in policy', () => {
  it('asks for every label the item strongly supports, since a policy that only allows labels leaves Haiku skipping obvious ones', () => {
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- Add every repository label that the item\'s main request, status, or content strongly supports, judging each label by its name and description.')
  })
})

describe('summary field', () => {
  it('asks the model to write down the facts the policy turns on, since Haiku acts on dates far more reliably once it has written them out', () => {
    const systemPrompt = buildSystemPrompt('Policy', '', [], undefined, makeConfig().limits)

    expect(systemPrompt).toContain("- summary (required, internal): a few sentences: what the item is, the facts the policy's rules turn on for it (such as dates and the days since them, labels, and who did what), and what follows from them. The operations must match it.")
  })
})
