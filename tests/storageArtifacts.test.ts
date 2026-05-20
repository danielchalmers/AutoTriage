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
  it('writes summary, completion time, and consumed GitHub watermark', () => {
    const db: TriageDb = { version: 2, items: {} }

    updateDbEntry(db, 42, 'summary', { lastSeenUpdatedAt: '2024-04-02T00:00:00.000Z' })

    expect(db.items['42']).toMatchObject({
      summary: 'summary',
      lastSeenUpdatedAt: '2024-04-02T00:00:00.000Z',
    })
    expect(db.items['42']?.lastTriaged).toEqual(expect.any(String))
  })
})

describe('loadDatabase', () => {
  it('migrates legacy flat databases to v2 and drops thoughts', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')
    fs.writeFileSync(dbPath, JSON.stringify({
      '42': {
        lastTriaged: '2024-01-01T00:00:00.000Z',
        summary: 'legacy summary',
        thoughts: 'legacy thoughts',
      },
      '43': {
        thoughts: 'drop me',
      },
      '44': {
        summary: 'keep me',
      },
    }, null, 2))

    try {
      expect(loadDatabase(dbPath)).toEqual({
        version: 2,
        items: {
          '42': {
            lastTriaged: '2024-01-01T00:00:00.000Z',
            lastSeenUpdatedAt: '2024-01-01T00:00:00.000Z',
            summary: 'legacy summary',
          },
          '44': {
            summary: 'keep me',
          },
        },
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('loads v2 databases from the items container', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')
    fs.writeFileSync(dbPath, JSON.stringify({
      version: 2,
      items: {
        '42': {
          lastTriaged: '2024-01-01T00:00:00.000Z',
          lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z',
          summary: 'v2 summary',
          thoughts: 'ignored',
        },
      },
    }, null, 2))

    try {
      expect(loadDatabase(dbPath)).toEqual({
        version: 2,
        items: {
          '42': {
            lastTriaged: '2024-01-01T00:00:00.000Z',
            lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z',
            summary: 'v2 summary',
          },
        },
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe('saveDatabase', () => {
  it('writes the v2 schema to disk', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')
    const db: TriageDb = {
      version: 2,
      items: {
        '42': {
          lastTriaged: '2024-01-01T00:00:00.000Z',
          lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z',
          summary: 'saved summary',
        },
      },
    }

    try {
      saveDatabase(db, dbPath, false)

      expect(JSON.parse(fs.readFileSync(dbPath, 'utf8'))).toEqual({
        version: 2,
        items: {
          '42': {
            lastTriaged: '2024-01-01T00:00:00.000Z',
            lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z',
            summary: 'saved summary',
          },
        },
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
