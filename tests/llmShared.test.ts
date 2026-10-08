import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// Nuntia copies src/llm/ verbatim, so the folder must stand alone and every change to it must be deliberate.
const LLM_DIR = path.join(__dirname, '..', 'src', 'llm')
const PINNED_HASH = 'sha256:b3fa340608609285099fdb328d15596296974c601596e7d8bf0846cfa1572ddf'

// Nuntia copies the shared tests too, so they must not reach outside src/llm/ either.
const LLM_TESTS_DIR = path.join(__dirname, 'llm')

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
  it('imports only its own files and undici', () => {
    for (const { name, text } of llmFiles()) {
      for (const specifier of importSpecifiers(text)) {
        expect(specifier, name).toMatch(/^(\.\/[\w-]+|undici)$/)
      }
    }
  })

  it('has shared tests that import only vitest, src/llm/ and each other', () => {
    const tests = llmFiles(LLM_TESTS_DIR)
    expect(tests.length).toBeGreaterThan(0)
    for (const { name, text } of tests) {
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
