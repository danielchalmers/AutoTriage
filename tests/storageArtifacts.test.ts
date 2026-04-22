import { describe, it, expect, vi } from 'vitest'
import { saveArtifact } from '../src/storage'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('saveArtifact', () => {
  it('stores prompt-system.md as a single shared artifact file', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-artifacts-'))
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir)

    try {
      saveArtifact(1, 'prompt-system.md', 'first')
      saveArtifact(2, 'prompt-system.md', 'second')

      const artifactsDir = path.join(tempDir, 'artifacts')
      const files = fs.readdirSync(artifactsDir).sort()
      expect(files).toEqual(['prompt-system.md'])
      expect(fs.readFileSync(path.join(artifactsDir, 'prompt-system.md'), 'utf8')).toBe('second')
    } finally {
      cwdSpy.mockRestore()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('keeps issue-prefixed names for other artifact files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-artifacts-'))
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir)

    try {
      saveArtifact(42, 'prompt-user.md', 'content')

      const artifactsDir = path.join(tempDir, 'artifacts')
      expect(fs.readdirSync(artifactsDir)).toEqual(['42-prompt-user.md'])
    } finally {
      cwdSpy.mockRestore()
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
