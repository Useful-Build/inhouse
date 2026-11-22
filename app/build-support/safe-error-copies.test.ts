// server/safe-error.ts and runner/src/safe-error.ts hold one rule in two copies (the runner's image can't import
// server/). Their code must stay the same; only the comments may differ.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const code = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map(l => l.replace(/^\s*\/\/.*$/, '').trimEnd())
  .filter(l => l !== '')
  .join('\n')

describe('the two safe-error copies', () => {
  it('have the same code', () => {
    expect(code('runner/src/safe-error.ts')).toBe(code('server/safe-error.ts'))
  })
})
