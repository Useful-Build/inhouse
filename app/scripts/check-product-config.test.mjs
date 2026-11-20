// scripts/check-product-config.mjs: one failing fixture per rule (each must exit 1 and name its rule), one passing
// fixture (exit 0), the test build's own config refused (exit 1, as CI requires), and usage or an unreadable file exit 2.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const script = fileURLToPath(new URL('./check-product-config.mjs', import.meta.url))
const fixtures = fileURLToPath(new URL('./check-product-config-fixtures/', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

/** What each failing fixture's report must say: the rule, not just any failure. */
const RULE_TEXT = {
  'test-build-var': 'vars.INHOUSE_TEST_BUILD is set',
  'test-issuer-jwks': 'vars.TEST_ISSUER_JWKS is set',
  'test-build-var-in-env': 'env.staging.vars.INHOUSE_TEST_BUILD is set',
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

  test('passes the deployable fixture with exit 0', () => {
    const r = run(`${fixtures}pass.jsonc`)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
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
