import { describe, it, expect } from 'vitest'
import { errorMessage } from '../src/util'

describe('errorMessage', () => {
  it('appends the cause code that fetch hides behind "fetch failed"', () => {
    const cause = Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' })

    expect(errorMessage(Object.assign(new TypeError('fetch failed'), { cause }))).toBe('fetch failed (UND_ERR_HEADERS_TIMEOUT)')
  })

  it('leaves messages without a cause code unchanged', () => {
    expect(errorMessage(new Error('bad request'))).toBe('bad request')
    expect(errorMessage(Object.assign(new Error('wrapped'), { cause: new Error('no code') }))).toBe('wrapped')
    expect(errorMessage(Object.assign(new Error('wrapped'), { cause: { code: 503 } }))).toBe('wrapped')
    expect(errorMessage('socket hang up')).toBe('socket hang up')
  })
})
