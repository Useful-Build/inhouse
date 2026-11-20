// scripts/sandbox/names.mjs, the sandbox name guard. Ways it could fail, written down first:
//  1. it admits a live product's name, a shared sandbox name as a per-PR one, or a near miss (pr0, a leading zero,
//     a suffix after the number with no hyphen, a prefix before `inhouse`, upper case, a trailing newline);
//  2. it refuses a real per-PR name, or says it belongs to the wrong PR;
//  3. a host passes on the wrong zone (a suffix attack, the bare zone, another zone, a deeper host, upper case);
//  4. it accepts a non-string.
// Oracles: literal lists, and for the properties a reference parser below that reads the names character by character
// and shares no code (and no regular expression) with names.mjs.
import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import {
  SandboxNameError, assertPerPrName, assertSandboxHost, assertSandboxName, isPerPrName, isSandboxName, prNumberOf,
} from './names.mjs'

const ZONE = 'zone.example.test'

const NOT_PER_PR = [
  'inhouse-sbx-db', 'inhouse-sbx-files', 'inhouse-sbx-product', 'inhouse-sbx-pr0', 'inhouse-sbx-pr012', 'inhouse-sbx-pr12x',
  'inhouse-sbx-pr1234567', 'inhouse-sbx-pr12-', 'inhouse-sbx-pr12-DB', 'inhouse-sbx-pr12-db1', 'inhouse-sbx-pr12-db-x',
  'xinhouse-sbx-pr1', 'inhouse-sbx-pr', 'Inhouse-sbx-pr1', 'inhouse-app', 'inhouse-app-preview', 'wasimjalali-com',
  'live-product-db', '', 'inhouse-sbx-pr12\n', ' inhouse-sbx-pr12', 'inhouse-sbx-pr12 ', 'inhouse-sbx-pr12.db',
]
const PER_PR = [['inhouse-sbx-pr12', 12], ['inhouse-sbx-pr12-db', 12], ['inhouse-sbx-pr12-files', 12], ['inhouse-sbx-pr1', 1], ['inhouse-sbx-pr999999-brand', 999999]]
const NOT_SANDBOX = ['inhouse-app', 'inhouse-product', 'wasimjalali-com', 'live-product-db', 'other-sessions', '', 'inhouse-sbx-', 'xinhouse-sbx-db', 'inhouse-sbx-DB', 'inhouse-sbx-db\n', 'inhouse-sbx_db', 'inhouse-sbx-db.x']
const SANDBOX = ['inhouse-sbx-db', 'inhouse-sbx-files', 'inhouse-sbx-product', 'inhouse-sbx-pr12', 'inhouse-sbx-pr12-db', 'inhouse-sbx-brand']

describe('the per-PR rule (failures 1, 2, 4)', () => {
  for (const name of NOT_PER_PR) {
    test(`refuses ${JSON.stringify(name)}`, () => {
      expect(isPerPrName(name)).toBe(false)
      expect(prNumberOf(name)).toBe(null)
      expect(() => assertPerPrName(name)).toThrow(SandboxNameError)
    })
  }
  for (const [name, pr] of PER_PR) {
    test(`accepts ${name} as PR ${pr}'s`, () => {
      expect(isPerPrName(name)).toBe(true)
      expect(prNumberOf(name)).toBe(pr)
      expect(assertPerPrName(name, pr)).toBe(name)
      expect(() => assertPerPrName(name, pr + 1)).toThrow(/belongs to PR/)
    })
  }
  test('refuses non-strings', () => {
    for (const v of [undefined, null, 12, ['inhouse-sbx-pr12'], { toString: () => 'inhouse-sbx-pr12' }]) {
      expect(isPerPrName(v)).toBe(false)
      expect(() => assertPerPrName(v)).toThrow(SandboxNameError)
      expect(isSandboxName(v)).toBe(false)
      expect(() => assertSandboxName(v)).toThrow(SandboxNameError)
    }
  })
})

describe('the sandbox-wide rule (failures 1, 4)', () => {
  for (const name of NOT_SANDBOX) {
    test(`refuses ${JSON.stringify(name)}`, () => {
      expect(isSandboxName(name)).toBe(false)
      expect(() => assertSandboxName(name)).toThrow(SandboxNameError)
    })
  }
  for (const name of SANDBOX) {
    test(`accepts ${name}`, () => expect(assertSandboxName(name)).toBe(name))
  }
})

describe('hosts (failure 3)', () => {
  const refused = [
    ['inhouse-sbx-pr12-brand.zone.example.test.evil.test', 'per-pr'],
    ['inhouse-sbx-pr12-brand.evil.test', 'per-pr'],
    ['inhouse-sbx-pr12-brand.xzone.example.test', 'per-pr'],
    ['inhouse-sbx-pr12-brandzone.example.test', 'per-pr'],
    ['zone.example.test', 'per-pr'],
    ['.zone.example.test', 'per-pr'],
    ['a.inhouse-sbx-pr12-brand.zone.example.test', 'per-pr'],
    ['INHOUSE-SBX-PR12-BRAND.zone.example.test', 'per-pr'],
    ['inhouse-sbx-pr12-brand.ZONE.example.test', 'per-pr'],
    ['inhouse-sbx-brand.zone.example.test', 'per-pr'],
    ['inhouse-sbx-pr12-brand.zone.example.test.', 'per-pr'],
    ['inhouse-app.zone.example.test', 'sandbox'],
    ['inhouse-sbx-brand.evil.test', 'sandbox'],
    ['inhouse-sbx-brand.zone.example.test/*', 'sandbox'],
  ]
  for (const [host, rule] of refused) {
    test(`refuses ${host} (${rule})`, () => expect(() => assertSandboxHost(host, ZONE, rule)).toThrow(SandboxNameError))
  }
  test('accepts the per-PR hosts for their own PR only, and the candidate hosts on the sandbox-wide rule', () => {
    expect(assertSandboxHost('inhouse-sbx-pr12-brand.zone.example.test', ZONE, 'per-pr', 12)).toBe('inhouse-sbx-pr12-brand.zone.example.test')
    expect(assertSandboxHost('inhouse-sbx-pr12-team.zone.example.test', ZONE, 'per-pr')).toBe('inhouse-sbx-pr12-team.zone.example.test')
    expect(() => assertSandboxHost('inhouse-sbx-pr12-team.zone.example.test', ZONE, 'per-pr', 13)).toThrow(/belongs to PR 12/)
    expect(assertSandboxHost('inhouse-sbx-brand.zone.example.test', ZONE, 'sandbox')).toBe('inhouse-sbx-brand.zone.example.test')
  })
  test('refuses a zone that is not a lowercase domain', () => {
    for (const zone of ['', 'example', 'Example.test', 'example.test.', '.example.test', 'exa mple.test', 'example.test\n', undefined]) {
      expect(() => assertSandboxHost(`inhouse-sbx-brand.${zone}`, zone, 'sandbox')).toThrow(/sandbox zone/)
    }
  })
})

// The reference: a per-PR name read character by character (no regular expressions).
const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const DIGITS = '0123456789'
function referencePrNumber(s) {
  const head = 'inhouse-sbx-pr'
  if (typeof s !== 'string' || !s.startsWith(head)) return null
  let i = head.length
  let digits = ''
  while (i < s.length && DIGITS.includes(s[i])) digits += s[i++]
  if (digits.length < 1 || digits.length > 6 || digits[0] === '0') return null
  if (i === s.length) return Number(digits)
  if (s[i] !== '-') return null
  const word = s.slice(i + 1)
  if (word.length === 0) return null
  for (const c of word) if (!LOWER.includes(c)) return null
  return Number(digits)
}
function referenceSandbox(s) {
  const head = 'inhouse-sbx-'
  if (typeof s !== 'string' || !s.startsWith(head) || s.length === head.length) return false
  for (const c of s.slice(head.length)) if (!LOWER.includes(c) && !DIGITS.includes(c) && c !== '-') return false
  return true
}

// Names built near the rules, so most cases land on a boundary instead of far outside it.
const piece = fc.constantFrom('inhouse-sbx-', 'inhouse-sbx-pr', 'pr', '0', '1', '12', '999999', '1000000', '-', 'db', 'DB', 'files', 'x', '\n', ' ', '.', '_', 'inhouse', 'app')
const nearName = fc.array(piece, { maxLength: 6 }).map(p => p.join(''))
const anyName = fc.oneof(nearName, fc.string({ maxLength: 30 }), fc.string({ unit: 'binary', maxLength: 30 }))

describe('the rules agree with the reference parser', () => {
  propTest.prop([anyName], { numRuns: 2000 })('per-PR', name => {
    expect(prNumberOf(name)).toBe(referencePrNumber(name))
    expect(isPerPrName(name)).toBe(referencePrNumber(name) !== null)
  })
  propTest.prop([anyName], { numRuns: 2000 })('sandbox-wide', name => {
    expect(isSandboxName(name)).toBe(referenceSandbox(name))
  })
  propTest.prop([anyName, fc.constantFrom('per-pr', 'sandbox')], { numRuns: 1000 })('hosts: exactly <name>.<zone>', (label, rule) => {
    const ok = rule === 'per-pr' ? referencePrNumber(label) !== null : referenceSandbox(label)
    const host = `${label}.${ZONE}`
    if (ok) expect(assertSandboxHost(host, ZONE, rule)).toBe(host)
    else expect(() => assertSandboxHost(host, ZONE, rule)).toThrow(SandboxNameError)
  })
})
