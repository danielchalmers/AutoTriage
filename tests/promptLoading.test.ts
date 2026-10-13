import { describe, it, expect } from 'vitest'
import { readPolicy } from '../src/storage'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt'
import { withTempFiles } from './fixtures'
import * as path from 'path'

describe('readPolicy', () => {
  it('reads the policy file, or returns undefined when the workspace lacks it', () => {
    withTempFiles({ 'prompt.txt': 'Custom test prompt' }, (file) => {
      expect(readPolicy(file('prompt.txt'))).toBe('Custom test prompt')
    })
    expect(readPolicy(path.join(__dirname, 'does-not-exist.txt'))).toBeUndefined()
  })
})

describe('built-in policy', () => {
  it('asks for every label the item strongly supports, since a policy that only allows labels leaves Haiku skipping obvious ones', () => {
    expect(BUILTIN_LABEL_ONLY_PROMPT).toContain('- Add every repository label that the item\'s main request, status, or content strongly supports, judging each label by its name and description.')
  })
})
