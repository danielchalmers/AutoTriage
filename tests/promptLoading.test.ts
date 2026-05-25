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

  it('falls back to bundled prompt when custom file does not exist', async () => {
    // Create a temporary bundled prompt file for testing
    const bundledPath = path.join(__dirname, '..', 'src', 'AutoTriage.prompt')
    const testContent = '# Test bundled prompt content'
    fs.writeFileSync(bundledPath, testContent)
    
    try {
      const nonExistentPath = path.join(__dirname, 'does-not-exist.txt')
      const result = await loadPrompt(nonExistentPath)
      expect(result).toBe(testContent)
    } finally {
      fs.unlinkSync(bundledPath)
    }
  })

  it('uses the built-in prompt when no path is provided and the bundled prompt is missing', async () => {
    const result = await loadPrompt('')
    expect(result).toBe(BUILTIN_LABEL_ONLY_PROMPT)
  })

  it('uses the built-in prompt when custom and bundled prompts are both missing', async () => {
    const result = await loadPrompt(path.join(__dirname, 'does-not-exist.txt'))
    expect(result).toBe(BUILTIN_LABEL_ONLY_PROMPT)
  })
})
