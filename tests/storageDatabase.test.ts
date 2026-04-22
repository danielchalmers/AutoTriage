import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadDatabase, saveDatabase, updateDbEntry } from '../src/storage'

describe('database storage', () => {
  it('drops persisted thoughts when loading and saving the database', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')

    try {
      fs.writeFileSync(dbPath, JSON.stringify({
        42: {
          summary: 'Needs follow-up',
          lastTriaged: '2024-01-01T00:00:00Z',
          thoughts: 'sensitive chain of thought',
        },
      }, null, 2))

      const db = loadDatabase(dbPath)
      expect(db).toEqual({
        42: {
          summary: 'Needs follow-up',
          lastTriaged: '2024-01-01T00:00:00Z',
        },
      })

      saveDatabase({
        ...db,
        99: {
          summary: 'New item',
          lastTriaged: '2024-01-02T00:00:00Z',
        },
      }, dbPath)

      expect(JSON.parse(fs.readFileSync(dbPath, 'utf8'))).toEqual({
        42: {
          summary: 'Needs follow-up',
          lastTriaged: '2024-01-01T00:00:00Z',
        },
        99: {
          summary: 'New item',
          lastTriaged: '2024-01-02T00:00:00Z',
        },
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('removes any existing thoughts when updating an entry', () => {
    const db = {
      7: {
        summary: 'Old summary',
        lastTriaged: '2024-01-01T00:00:00Z',
        thoughts: 'old thoughts',
      },
    }

    updateDbEntry(db, 7, 'Updated summary')

    expect(db[7]).toMatchObject({
      summary: 'Updated summary',
    })
    expect(db[7]).not.toHaveProperty('thoughts')
    expect(typeof db[7].lastTriaged).toBe('string')
  })
})
