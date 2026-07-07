import { describe, it, expect } from 'vitest'
import { loadPrompt } from '../src/storage'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt'
import * as fs from 'fs'
import * as path from 'path'

describe('prompt loading', () => {
  it('loads custom prompt when file exists', async () => {
    const customPromptPath = path.join(__dirname, 'test-prompt.txt')
    fs.writeFileSync(customPromptPath, 'Custom test prompt')
    
    try {
      const result = await loadPrompt(customPromptPath)
      expect(result).toBe('Custom test prompt')
    } finally {
      fs.unlinkSync(customPromptPath)
    }
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
