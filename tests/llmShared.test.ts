import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// Nuntia copies src/llm/ verbatim, so the folder must stand alone and every change to it must be deliberate.
const LLM_DIR = path.join(__dirname, '..', 'src', 'llm')
const HEADER = '// Source: AutoTriage (danielchalmers/AutoTriage, src/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.'

// Update this after changing src/llm/, and copy the folder to Nuntia in a paired PR.
const PINNED_HASH = 'sha256:f1ae186262ffcdbc09954ed56cf48b995cc948a3df6605d1d289211e05333334'

// Nuntia copies the shared tests too, so they must not reach outside src/llm/ either.
const LLM_TESTS_DIR = path.join(__dirname, 'llm')
const TESTS_HEADER = '// Source: AutoTriage (danielchalmers/AutoTriage, tests/llm/). Nuntia copies this folder verbatim, so change it in AutoTriage and copy it over in a paired PR.'

function llmFiles(dir = LLM_DIR): Array<{ name: string; text: string }> {
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.ts'))
    .sort()
    // Line endings are normalized so a Windows checkout hashes the same as CI.
    .map(name => ({ name, text: fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n') }))
}

function importSpecifiers(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+'([^']+)'/gm)].map(match => match[1]!)
}

describe('src/llm', () => {
  it('names AutoTriage as the source at the top of every file', () => {
    for (const { name, text } of llmFiles()) {
      expect(text.split('\n')[0], name).toBe(HEADER)
    }
  })

  it('imports only its own files and undici', () => {
    for (const { name, text } of llmFiles()) {
      for (const specifier of importSpecifiers(text)) {
        expect(specifier, name).toMatch(/^(\.\/[\w-]+|undici)$/)
      }
    }
  })

  it('has shared tests that name AutoTriage as the source and import only vitest, src/llm/ and each other', () => {
    const tests = llmFiles(LLM_TESTS_DIR)
    expect(tests.length).toBeGreaterThan(0)
    for (const { name, text } of tests) {
      expect(text.split('\n')[0], name).toBe(TESTS_HEADER)
      for (const specifier of importSpecifiers(text)) {
        expect(specifier, name).toMatch(/^(\.\/[\w-]+|\.\.\/\.\.\/src\/llm\/[\w-]+|vitest)$/)
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
