import { afterEach, describe, it, expect, vi } from 'vitest'
import { hasPromptFile, loadPrompt } from '../src/storage'
import { BUILTIN_LABEL_ONLY_PROMPT } from '../src/prompt'
import { withTempFiles } from './fixtures'
import * as path from 'path'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('prompt loading', () => {
  it('loads custom prompt when file exists', async () => {

    withTempFiles({ 'prompt.txt': 'Custom test prompt' }, (file) => {
      expect(loadPrompt(file('prompt.txt'))).toBe('Custom test prompt')
    })
  })

  it('uses the built-in label-only prompt when no path is provided', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await loadPrompt('')

    expect(result).toBe(BUILTIN_LABEL_ONLY_PROMPT)
    expect(warn).toHaveBeenCalledWith('⚠️ No AutoTriage prompt found (no prompt path configured); using built-in label-only prompt.')
  })

  it('uses the built-in label-only prompt when the custom prompt is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = path.join(__dirname, 'does-not-exist.txt')

    const result = await loadPrompt(missing)

    expect(result).toBe(BUILTIN_LABEL_ONLY_PROMPT)
    expect(warn).toHaveBeenCalledWith(`⚠️ No AutoTriage prompt found (custom path '${missing}'); using built-in label-only prompt.`)
  })

  it('reports whether a policy file exists, so the job summary can name the policy in use', () => {
    withTempFiles({ 'prompt.txt': 'Custom test prompt' }, (file) => {
      expect(hasPromptFile(file('prompt.txt'))).toBe(true)
    })
    expect(hasPromptFile(path.join(__dirname, 'does-not-exist.txt'))).toBe(false)
    expect(hasPromptFile('')).toBe(false)
  })
})
