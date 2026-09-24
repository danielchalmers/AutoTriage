import { afterEach, describe, it, expect, vi } from 'vitest'
import { loadDatabase, loadReadme, saveArtifact, saveDatabase, updateDbEntry } from '../src/storage'
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

  it('keeps the previous watermark when no new one is supplied', () => {
    const db: TriageDb = {
      version: 2,
      items: { '42': { lastTriaged: '2024-01-01T00:00:00.000Z', lastSeenUpdatedAt: '2024-01-01T00:00:00.000Z', summary: 'old' } },
    }

    updateDbEntry(db, 42, 'new')

    expect(db.items['42']).toMatchObject({ summary: 'new', lastSeenUpdatedAt: '2024-01-01T00:00:00.000Z' })
    expect(db.items['42']?.lastTriaged).not.toBe('2024-01-01T00:00:00.000Z')
  })
})

describe('loadDatabase', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const EMPTY_DB = { version: 2, items: {} }

  it('starts empty without a configured path or when the file does not exist yet', async () => {
    expect(loadDatabase(undefined)).toEqual(EMPTY_DB)
    await withTempDir((tempDir) => {
      expect(loadDatabase(path.join(tempDir, 'missing.json'))).toEqual(EMPTY_DB)
    })
  })

  it('starts empty from an empty file', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await withTempDir((tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json')
      fs.writeFileSync(dbPath, '')

      expect(loadDatabase(dbPath)).toEqual(EMPTY_DB)
    })
  })

  it('logs and starts empty instead of failing the run on corrupt JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await withTempDir((tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json')
      fs.writeFileSync(dbPath, '{"version": 2, "items": {')

      expect(loadDatabase(dbPath)).toEqual(EMPTY_DB)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Starting with empty database'))
    })
  })

  it('drops legacy entries whose lastTriaged is not a date', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await withTempDir((tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json')
      fs.writeFileSync(dbPath, JSON.stringify({ '42': { lastTriaged: 'yesterday' }, '43': 'not an object' }))

      expect(loadDatabase(dbPath)).toEqual(EMPTY_DB)
    })
  })

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
  it('does not write in dry-run mode', async () => {
    await withTempDir((tempDir) => {
      const dbPath = path.join(tempDir, 'triage-db.json')

      saveDatabase({ version: 2, items: {} }, dbPath, true)

      expect(fs.existsSync(dbPath)).toBe(false)
    })
  })

  it('creates missing parent directories', async () => {
    await withTempDir((tempDir) => {
      const dbPath = path.join(tempDir, 'nested', 'dir', 'triage-db.json')

      saveDatabase({ version: 2, items: {} }, dbPath, false)

      expect(JSON.parse(fs.readFileSync(dbPath, 'utf8'))).toEqual({ version: 2, items: {} })
    })
  })

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

describe('loadReadme', () => {
  it('reads the README relative to the working directory', async () => {
    await withArtifactsDir((tempDir) => {
      fs.writeFileSync(path.join(tempDir, 'README.md'), '# Project')

      expect(loadReadme('README.md')).toBe('# Project')
    })
  })

  it('returns an empty string when there is no README', async () => {
    await withArtifactsDir(() => {
      expect(loadReadme('README.md')).toBe('')
      expect(loadReadme('')).toBe('')
    })
  })
})
