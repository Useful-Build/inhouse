// scripts/sandbox/names.mjs, the sandbox name guard. Ways it could fail, written down first:
//  1. it admits a live product's name, a shared sandbox name as a per-PR one, or a near miss (pr0, a leading zero,
//     a suffix after the number with no hyphen, a prefix before `inhouse`, upper case, a trailing newline);
//  2. it refuses a real per-PR name, or says it belongs to the wrong PR;
//  3. a host passes on the wrong zone (a suffix attack, the bare zone, another zone, a deeper host, upper case);
//  4. it accepts a non-string;
//  5. (eval build, p3-eval-observability rev 2 rec 2) the eval deployment's names overlap a PR's or the candidate's: a
//     per-PR deploy or cleanup could then touch the eval brand, or the candidate bind its data; or a near miss passes as
//     an eval name.
// Oracles: literal lists, and for the properties a reference parser below that reads the names character by character
// and shares no code (and no regular expression) with names.mjs.
import { fc, test as propTest } from '@fast-check/vitest'
import { describe, expect, test } from 'vitest'
import {
  SandboxNameError, assertCandidateName, assertEvalName, assertPerPrName, assertPrNumber, assertSandboxHost, assertSandboxName,
  evalNames, isEvalName, isPerPrName, isSandboxName, perPrNames, prNumberOf,
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

describe('PR numbers, PR names and the candidate rule (failures 1, 2)', () => {
  test('perPrNames gives PR 12 its literal names, and refuses anything but a PR number', () => {
    expect(perPrNames(12)).toEqual({
      worker: 'inhouse-sbx-pr12', d1: 'inhouse-sbx-pr12-db', r2: 'inhouse-sbx-pr12-files', container: 'inhouse-sbx-pr12',
      image: 'inhouse-sbx-pr12', brand: 'inhouse-sbx-pr12-brand', team: 'inhouse-sbx-pr12-team',
    })
    expect(perPrNames(999999).d1).toBe('inhouse-sbx-pr999999-db')
    for (const pr of [0, -1, 1.5, 1_000_000, '12', NaN, undefined, null]) {
      expect(() => assertPrNumber(pr), String(pr)).toThrow(SandboxNameError)
      expect(() => perPrNames(pr), String(pr)).toThrow(SandboxNameError)
    }
  })
  test('the candidate rule takes shared sandbox names only', () => {
    for (const name of ['inhouse-sbx-db', 'inhouse-sbx-files', 'inhouse-sbx-product', 'inhouse-sbx-brand']) expect(assertCandidateName(name)).toBe(name)
    for (const name of ['inhouse-sbx-pr12', 'inhouse-sbx-pr12-db', 'inhouse-app', '', 'inhouse-sbx-DB']) expect(() => assertCandidateName(name), name).toThrow(SandboxNameError)
    expect(assertSandboxHost('inhouse-sbx-brand.zone.example.test', 'zone.example.test', 'candidate')).toBe('inhouse-sbx-brand.zone.example.test')
    expect(() => assertSandboxHost('inhouse-sbx-pr12-brand.zone.example.test', 'zone.example.test', 'candidate')).toThrow(/per-PR name/)
  })
})

describe('the eval deployment\'s names (failure 5)', () => {
  const EVAL = ['inhouse-sbx-eval', 'inhouse-sbx-eval-db', 'inhouse-sbx-eval-files', 'inhouse-sbx-eval-brand', 'inhouse-sbx-eval-team']
  const NEAR = ['inhouse-sbx-evals', 'inhouse-sbx-evaluation', 'inhouse-sbx-eval-', 'inhouse-sbx-eval-DB', 'inhouse-sbx-eval-db1',
    'inhouse-sbx-eval-db-x', 'xinhouse-sbx-eval', 'inhouse-sbx-eval\n', 'inhouse-sbx-eval.db', 'inhouse-eval', '']
  test('evalNames gives its literal names', () => {
    expect(evalNames()).toEqual({
      worker: 'inhouse-sbx-eval', d1: 'inhouse-sbx-eval-db', r2: 'inhouse-sbx-eval-files', container: 'inhouse-sbx-eval',
      image: 'inhouse-sbx-eval', brand: 'inhouse-sbx-eval-brand', team: 'inhouse-sbx-eval-team',
    })
  })
  test('the eval rule takes the eval names and no near miss', () => {
    for (const name of EVAL) {
      expect(isEvalName(name), name).toBe(true)
      expect(assertEvalName(name)).toBe(name)
    }
    for (const name of [...NEAR, 'inhouse-sbx-db', 'inhouse-sbx-pr12', 'inhouse-sbx-pr12-db', 'inhouse-app', 7, null]) {
      expect(isEvalName(name), String(name)).toBe(false)
      expect(() => assertEvalName(name), String(name)).toThrow(SandboxNameError)
    }
  })
  test('disjoint from the per-PR and candidate rules', () => {
    for (const name of EVAL) {
      expect(isPerPrName(name), name).toBe(false)
      expect(() => assertCandidateName(name), name).toThrow(/eval deployment's name/)
    }
    for (const name of Object.values(perPrNames(12))) expect(isEvalName(name), name).toBe(false)
    // A near miss isn't the eval's, so the candidate rule keeps it.
    expect(assertCandidateName('inhouse-sbx-evaluation')).toBe('inhouse-sbx-evaluation')
  })
  test('hosts: the eval rule takes the eval hosts only, and the candidate rule refuses them', () => {
    expect(assertSandboxHost(`inhouse-sbx-eval-brand.${ZONE}`, ZONE, 'eval')).toBe(`inhouse-sbx-eval-brand.${ZONE}`)
    expect(() => assertSandboxHost(`inhouse-sbx-brand.${ZONE}`, ZONE, 'eval')).toThrow(SandboxNameError)
    expect(() => assertSandboxHost(`inhouse-sbx-eval-brand.other.test`, ZONE, 'eval')).toThrow(SandboxNameError)
    // #240 review S-L3: only the two host names, never another eval name as a host label.
    expect(assertSandboxHost(`inhouse-sbx-eval-team.${ZONE}`, ZONE, 'eval')).toBe(`inhouse-sbx-eval-team.${ZONE}`)
    for (const label of ['inhouse-sbx-eval', 'inhouse-sbx-eval-db', 'inhouse-sbx-eval-files']) {
      expect(() => assertSandboxHost(`${label}.${ZONE}`, ZONE, 'eval'), label).toThrow(/not one of the eval deployment's hosts/)
    }
    expect(() => assertSandboxHost(`inhouse-sbx-eval-brand.${ZONE}`, ZONE, 'candidate')).toThrow(/eval deployment's name/)
  })
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
