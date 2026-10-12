import { afterEach, describe, it, expect, vi } from 'vitest'
import { DB_FILE, loadDatabase, saveArtifact, saveDatabase, saveRunArtifact, updateDbEntry } from '../src/storage'
import { withArtifactsDir } from './fixtures'
import * as fs from 'fs'
import * as path from 'path'
import type { TriageDb } from '../src/storage'

describe('saveArtifact', () => {
  it('stores run-level artifacts under their bare names', async () => {
    await withArtifactsDir((tempDir) => {
      saveRunArtifact('prompt-system.md', 'first')
      saveRunArtifact('prompt-system.md', 'second')
      saveRunArtifact('run-summary.json', '{}')

      const artifactsDir = path.join(tempDir, 'artifacts')
      const files = fs.readdirSync(artifactsDir).sort()
      expect(files).toEqual(['prompt-system.md', 'run-summary.json'])
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
  it('writes the completion time and the consumed GitHub watermark, and no summary', () => {
    const db: TriageDb = { version: 2, items: {} }

    updateDbEntry(db, 42, '2024-04-02T00:00:00.000Z')

    expect(db.items['42']).toEqual({ lastTriaged: expect.any(String), lastSeenUpdatedAt: '2024-04-02T00:00:00.000Z' })
  })

  it('keeps the previous watermark when no new one is supplied', () => {
    const db: TriageDb = {
      version: 2,
      items: { '42': { lastTriaged: '2024-01-01T00:00:00.000Z', lastSeenUpdatedAt: '2024-01-01T00:00:00.000Z' } },
    }

    updateDbEntry(db, 42)

    expect(db.items['42']).toMatchObject({ lastSeenUpdatedAt: '2024-01-01T00:00:00.000Z' })
    expect(db.items['42']?.lastTriaged).not.toBe('2024-01-01T00:00:00.000Z')
  })
})

// The database is always triage-db.json in the working directory, which withArtifactsDir points at a throwaway directory.
describe('loadDatabase', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const EMPTY_DB = { version: 2, items: {} }

  it('starts empty when the working directory has no triage-db.json yet, or an empty one', async () => {
    await withArtifactsDir((tempDir) => {
      expect(loadDatabase()).toEqual(EMPTY_DB)

      fs.writeFileSync(path.join(tempDir, DB_FILE), '')
      expect(loadDatabase()).toEqual(EMPTY_DB)
    })
  })

  it('logs and starts empty instead of failing the run on corrupt JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await withArtifactsDir((tempDir) => {
      fs.writeFileSync(path.join(tempDir, DB_FILE), '{"version": 2, "items": {')

      expect(loadDatabase()).toEqual(EMPTY_DB)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Starting with empty database'))
    })
  })

  it.each([
    ['the flat version 1 map', { '42': { lastTriaged: '2024-01-01T00:00:00.000Z', summary: 'legacy summary' } }],
    ['another version', { version: 3, items: {} }],
    ['a list', []],
  ])('warns and starts empty instead of reading %s', async (_name, contents) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withArtifactsDir((tempDir) => {
      fs.writeFileSync(path.join(tempDir, DB_FILE), JSON.stringify(contents))

      expect(loadDatabase()).toEqual(EMPTY_DB)
      expect(warnSpy).toHaveBeenCalledExactlyOnceWith("⚠️ triage-db.json isn't a version 2 triage database, so it's ignored and every item counts as new.")
    })
  })

  it('loads the version 2 items, and ignores the summary that earlier versions wrote and any other unknown field', async () => {
    await withArtifactsDir((tempDir) => {
      fs.writeFileSync(path.join(tempDir, DB_FILE), JSON.stringify({
        version: 2,
        items: {
          '42': {
            lastTriaged: '2024-01-01T00:00:00.000Z',
            lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z',
            summary: 'v2 summary',
            thoughts: 'ignored',
          },
          '43': { summary: 'only a summary' },
          '44': 'not an object',
        },
      }, null, 2))

      expect(loadDatabase()).toEqual({
        version: 2,
        items: {
          '42': {
            lastTriaged: '2024-01-01T00:00:00.000Z',
            lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z',
          },
        },
      })
    })
  })
})

describe('saveDatabase', () => {
  const db: TriageDb = {
    version: 2,
    items: { '42': { lastTriaged: '2024-01-01T00:00:00.000Z', lastSeenUpdatedAt: '2024-01-02T00:00:00.000Z' } },
  }

  it('does not write in dry-run mode', async () => {
    await withArtifactsDir((tempDir) => {
      saveDatabase(db, true)

      expect(fs.existsSync(path.join(tempDir, DB_FILE))).toBe(false)
    })
  })

  it('writes triage-db.json in the working directory, which the next run loads', async () => {
    await withArtifactsDir((tempDir) => {
      saveDatabase(db, false)

      expect(JSON.parse(fs.readFileSync(path.join(tempDir, 'triage-db.json'), 'utf8'))).toEqual(db)
      expect(loadDatabase()).toEqual(db)
    })
  })
})
