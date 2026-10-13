import { describe, it, expect } from 'vitest'
import { readWorkspaceFile } from '../src/storage'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompts'
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
