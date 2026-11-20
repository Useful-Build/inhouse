// scripts/check-product-config.mjs: one failing fixture per rule (each must exit 1 and name its rule), one passing
// fixture per JSONC shape the parser must take (exit 0), the test build's own config refused (exit 1, as CI requires), and usage or an unreadable file exit 2.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { stripJsonc } from './check-product-config.mjs'

const script = fileURLToPath(new URL('./check-product-config.mjs', import.meta.url))
const fixtures = fileURLToPath(new URL('./check-product-config-fixtures/', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

/** What each failing fixture's report must say: the rule, not just any failure. */
const RULE_TEXT = {
  'test-build-var': 'vars.INHOUSE_TEST_BUILD is set',
  'test-issuer-jwks': 'vars.TEST_ISSUER_JWKS is set',
  'env-block': 'env is set: a deployable config has no env blocks',
  'apps-no-inhouse': 'must be exactly one "brand" app and one "inhouse" app',
  'apps-two-brands': 'must be exactly one "brand" app and one "inhouse" app',
  'team-domain': 'teamDomain must be https://<name>.cloudflareaccess.com',
  'access-not-json': 'INHOUSE_ACCESS is missing or not JSON',
  'app-no-origin': 'has no origin',
  'app-no-aud': 'has no aud',
  'origin-not-https': 'must be a bare https:// origin',
  'shared-origin': 'shares its hostname',
  'shared-hostname': 'shares its hostname',
  'shared-aud': 'shares its aud',
  'aud-not-hex': 'aud must be 64 hex',
  'service-token-role': 'maps a token to "admin"',
  'brand-workers-dev': 'workers.dev or preview hostname',
  'brand-preview-host': 'workers.dev or preview hostname',
  'workers-dev-true': 'workers_dev must be false',
  'preview-urls-true': 'preview_urls must be false',
  'workers-dev-missing': 'workers_dev must be false',
  'secret-var-named': 'vars.AUDIT_HASH_KEY looks like a secret',
  'secret-var-pattern': 'vars.SESSION_TOKEN looks like a secret',
}

describe('check-product-config', () => {
  const failing = readdirSync(fixtures).filter(f => f.startsWith('fail-')).map(f => f.slice(5, -'.jsonc'.length))

  test('every rule has a failing fixture, and every failing fixture a rule', () => {
    expect(failing.sort()).toEqual(Object.keys(RULE_TEXT).sort())
  })

  for (const rule of Object.keys(RULE_TEXT)) {
    test(`refuses ${rule} with exit 1 and names it`, () => {
      const r = run(`${fixtures}fail-${rule}.jsonc`)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(RULE_TEXT[rule])
      // One rule broken: exactly one failure listed.
      expect(r.stderr.split('\n').filter(l => l.startsWith('  - '))).toHaveLength(1)
    })
  }

  for (const pass of readdirSync(fixtures).filter(f => f.startsWith('pass'))) {
    test(`passes ${pass} with exit 0`, () => {
      const r = run(`${fixtures}${pass}`)
      expect(r.stderr).toBe('')
      expect(r.status).toBe(0)
    })
  }

  test('stripJsonc drops a trailing comma before comments and the closing bracket, and keeps commas in strings', () => {
    expect(JSON.parse(stripJsonc('{"a": 1, // c\n /* d */ }'))).toEqual({ a: 1 })
    expect(JSON.parse(stripJsonc('[1, /* x */\n]'))).toEqual([1])
    expect(JSON.parse(stripJsonc('{"a": ",}", "b": [1, 2], /* , */ "c": 3}'))).toEqual({ a: ',}', b: [1, 2], c: 3 })
  })

  // The real deployable template: INHOUSE_ACCESS is filled the way the ops repo fills it, from the pass fixture's value.
  const template = fileURLToPath(new URL('../wrangler.product.jsonc', import.meta.url))
  const accessOf = file => JSON.parse(stripJsonc(readFileSync(file, 'utf8'))).vars.INHOUSE_ACCESS
  test('passes wrangler.product.jsonc with INHOUSE_ACCESS filled in', () => {
    const config = JSON.parse(stripJsonc(readFileSync(template, 'utf8')))
    config.vars.INHOUSE_ACCESS = accessOf(`${fixtures}pass.jsonc`)
    const file = join(mkdtempSync(join(tmpdir(), 'product-config-')), 'filled.json')
    writeFileSync(file, JSON.stringify(config))
    const r = run(file)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  test('refuses the unfilled wrangler.product.jsonc on INHOUSE_ACCESS only', () => {
    const r = run(template)
    expect(r.status).toBe(1)
    const lines = r.stderr.split('\n').filter(l => l.startsWith('  - '))
    expect(lines).toEqual(['  - vars.INHOUSE_ACCESS is missing or not JSON'])
  })

  test('refuses wrangler.test.jsonc with exit 1, listing every reason', () => {
    const r = run(fileURLToPath(new URL('../wrangler.test.jsonc', import.meta.url)))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('vars.INHOUSE_TEST_BUILD is set')
    expect(r.stderr).toContain('teamDomain must be')
    expect(r.stderr).toContain('must be a bare https:// origin')
  })

  test('usage and an unreadable file exit 2', () => {
    expect(run().status).toBe(2)
    expect(run('a', 'b').status).toBe(2)
    expect(run(`${fixtures}does-not-exist.jsonc`).status).toBe(2)
  })
})
