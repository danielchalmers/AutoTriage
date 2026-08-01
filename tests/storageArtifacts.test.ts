import { describe, it, expect } from 'vitest'
import { loadDatabase, saveArtifact, saveDatabase, updateDbEntry } from '../src/storage'
import { withArtifactsDir, withTempDir } from './fixtures'
import * as fs from 'fs'
import * as path from 'path'
import type { TriageDb } from '../src/storage'

describe('saveArtifact', () => {
  it('stores prompt-system.md as a single shared artifact file', async () => {
    await withArtifactsDir((tempDir) => {
      saveArtifact(1, 'prompt-system.md', 'first')
      saveArtifact(2, 'prompt-system.md', 'second')

      const artifactsDir = path.join(tempDir, 'artifacts')
      const files = fs.readdirSync(artifactsDir).sort()
      expect(files).toEqual(['prompt-system.md'])
      expect(fs.readFileSync(path.join(artifactsDir, 'prompt-system.md'), 'utf8')).toBe('second')
    })
  })

  it('keeps issue-prefixed names for other artifact files', async () => {
    await withArtifactsDir((tempDir) => {
      saveArtifact(42, 'prompt-user.md', 'content')

      expect(fs.readdirSync(path.join(tempDir, 'artifacts'))).toEqual(['42-prompt-user.md'])
    })
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
  it('migrates legacy flat databases to v2 and drops thoughts', async () => {
    await withTempDir((tempDir) => {
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
    })
  })

  it('loads v2 databases from the items container', async () => {
    await withTempDir((tempDir) => {
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
    })
  })
})

describe('saveDatabase', () => {
  it('writes the v2 schema to disk', async () => {
    await withTempDir((tempDir) => {
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
    })
  })
})
