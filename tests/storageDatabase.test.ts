import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadDatabase, saveDatabase, updateDbEntry } from '../src/storage'

describe('triage database storage', () => {
  it('removes thoughts and other unused fields when loading and saving the database', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autotriage-db-'))
    const dbPath = path.join(tempDir, 'triage-db.json')

    try {
      fs.writeFileSync(dbPath, JSON.stringify({
        '13087': {
          summary: 'Keep summary',
          thoughts: 'remove me',
          lastTriaged: '2026-04-20T06:47:58.477Z',
          extraField: 'remove me too',
        },
      }, null, 2))

      const db = loadDatabase(dbPath)
      expect(db).toEqual({
        '13087': {
          summary: 'Keep summary',
          lastTriaged: '2026-04-20T06:47:58.477Z',
        },
      })

      saveDatabase(db, dbPath)
      expect(JSON.parse(fs.readFileSync(dbPath, 'utf8'))).toEqual({
        '13087': {
          summary: 'Keep summary',
          lastTriaged: '2026-04-20T06:47:58.477Z',
        },
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('updates entries without storing thoughts', () => {
    const db = {
      '5': {
        summary: 'Old summary',
        lastTriaged: '2025-01-01T00:00:00.000Z',
        thoughts: 'old thoughts that should not survive',
      },
    }

    updateDbEntry(db, 5, 'New summary')

    expect(db['5'].summary).toBe('New summary')
    expect(db['5'].lastTriaged).toEqual(expect.any(String))
    expect(db['5']).not.toHaveProperty('thoughts')
  })
})
