import { describe, it, expect } from 'vitest'
import { loadPrompt } from '../src/storage'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt'
import { withTempFiles } from './fixtures'
import * as path from 'path'

describe('prompt loading', () => {
  it('loads custom prompt when file exists', async () => {
    const customPromptPath = path.join(__dirname, 'test-prompt.txt')

    withTempFiles({ [customPromptPath]: 'Custom test prompt' }, () => {
      expect(loadPrompt(customPromptPath)).toBe('Custom test prompt')
    })
  })

  it('uses the built-in label-only prompt when no path is provided', async () => {
    const result = await loadPrompt('')
    expect(result).toBe(BUILTIN_LABEL_ONLY_PROMPT)
  })

  it('uses the built-in label-only prompt when the custom prompt is missing', async () => {
    const result = await loadPrompt(path.join(__dirname, 'does-not-exist.txt'))
    expect(result).toBe(BUILTIN_LABEL_ONLY_PROMPT)
  })
})
