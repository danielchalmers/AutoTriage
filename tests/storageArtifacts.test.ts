import { describe, it, expect, vi } from 'vitest'
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry } from '../src/storage'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { TriageDb } from '../src/storage'

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

describe('updateDbEntry', () => {
  it('does not persist thoughts for new triage entries', () => {
    const db: TriageDb = {}

    updateDbEntry(db, 42, 'summary')

    expect(db['42']).toMatchObject({
      summary: 'summary',
    })
    expect((db['42'] as any)?.thoughts).toBeUndefined()
    expect(db['42']?.lastTriaged).toEqual(expect.any(String))
  })

  it('removes legacy thoughts from existing entries', () => {
    const db = {
      '42': {
        thoughts: 'legacy thoughts',
        lastTriaged: '2024-01-01T00:00:00.000Z',
      },
    } as unknown as TriageDb

    updateDbEntry(db, 42, 'updated summary')

    expect(db['42']).toMatchObject({
      summary: 'updated summary',
    })
    expect((db['42'] as any)?.thoughts).toBeUndefined()
    expect(db['42']?.lastTriaged).not.toBe('2024-01-01T00:00:00.000Z')
  })
})

describe('database thought sanitization', () => {
  it('drops legacy thoughts when loading the database', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')
    fs.writeFileSync(dbPath, JSON.stringify({
      '42': {
        thoughts: 'legacy thoughts',
        summary: 'kept summary',
        lastTriaged: '2024-01-01T00:00:00.000Z',
      },
    }))

    try {
      const db = loadDatabase(dbPath)
      expect(db['42']).toEqual({
        summary: 'kept summary',
        lastTriaged: '2024-01-01T00:00:00.000Z',
      })
      expect((db['42'] as any)?.thoughts).toBeUndefined()
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not write legacy thoughts back to disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')
    const db = {
      '42': {
        thoughts: 'legacy thoughts',
        summary: 'kept summary',
      },
    } as unknown as TriageDb

    try {
      saveDatabase(db, dbPath, false)
      const saved = JSON.parse(fs.readFileSync(dbPath, 'utf8'))
      expect(saved).toEqual({
        '42': {
          summary: 'kept summary',
        },
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
