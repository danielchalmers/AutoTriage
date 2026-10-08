import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// Nuntia copies src/llm/ verbatim, so the folder must stand alone and every change to it must be deliberate.
const LLM_DIR = path.join(__dirname, '..', 'src', 'llm')
const HEADER = '// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.'

// Update this after changing src/llm/, and copy the folder to Nuntia in a paired PR.
const PINNED_HASH = 'sha256:daa0e8789cfad23ab09489c8302c6554f8f6cfc2c5a0979db19ae56dd6f2cdc4'

function llmFiles(): Array<{ name: string; text: string }> {
  return fs.readdirSync(LLM_DIR)
    .filter(name => name.endsWith('.ts'))
    .sort()
    // Line endings are normalized so a Windows checkout hashes the same as CI.
    .map(name => ({ name, text: fs.readFileSync(path.join(LLM_DIR, name), 'utf8').replace(/\r\n/g, '\n') }))
}

describe('src/llm', () => {
  it('names AutoTriage as the source at the top of every file', () => {
    for (const { name, text } of llmFiles()) {
      expect(text.split('\n')[0], name).toBe(HEADER)
    }
  })

  it('imports only its own files and undici', () => {
    for (const { name, text } of llmFiles()) {
      const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(match => match[1])
      for (const specifier of specifiers) {
        expect(specifier, name).toMatch(/^(\.\/[\w-]+|undici)$/)
      }
    }
  })

  it('matches the pinned content hash', () => {
    const hash = createHash('sha256')
    for (const { name, text } of llmFiles()) {
      hash.update(`${name}\n${text}\n`)
    }

    expect(`sha256:${hash.digest('hex')}`, 'src/llm/ changed: update PINNED_HASH and copy the folder to Nuntia in a paired PR').toBe(PINNED_HASH)
  })
})
