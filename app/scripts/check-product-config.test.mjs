// scripts/check-product-config.mjs: one failing fixture per rule (each must exit 1 and name its rule), one passing
// fixture per JSONC shape the parser must take (exit 0), the test build's own config refused (exit 1, as CI requires), and usage or an unreadable file exit 2.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { checkHub, checkPool, stripJsonc } from './check-product-config.mjs'

const script = fileURLToPath(new URL('./check-product-config.mjs', import.meta.url))
const fixtures = fileURLToPath(new URL('./check-product-config-fixtures/', import.meta.url))
const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })

/** What each failing fixture's report must say: the rule, not just any failure. */
const RULE_TEXT = {
  'test-build-var': 'vars.INHOUSE_TEST_BUILD is set',
  'test-issuer-jwks': 'vars.TEST_ISSUER_JWKS is set',
  // The eval build (p3-eval-observability rev 2, rec 2): the eval brand marker is the sandbox eval deployment's alone.
  'eval-brand-var': "vars.INHOUSE_EVAL_BRAND is set: only the sandbox's eval deployment is an eval brand",
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
  'version-metadata-missing': 'version_metadata needs a binding name',
  'secret-var-named': 'vars.AUDIT_HASH_KEY looks like a secret',
  'secret-var-pattern': 'vars.SESSION_TOKEN looks like a secret',
  // P8a F2: the Shopify webhook secrets are a Worker secret, never a var (its name ends in SECRETS, which the pattern misses).
  'secret-var-webhook': 'vars.SHOPIFY_WEBHOOK_SECRETS looks like a secret',
  // P3 (p3-design section 7).
  'pool-mismatch': "the Runner container's max_instances (4) must be 3 x RUNNER_POOL (6)",
  'pool-not-number': 'vars.RUNNER_POOL must be a whole number of 2 or more',
  'pool-no-container': 'containers must be exactly one, for the Runner class',
  // P3 (p3-design 8.2): the gateway the egress calls must be named.
  'gateway-id-empty': 'vars.AI_GATEWAY_ID must name the AI Gateway',
  // P4 (p4-h1.md OC 4), widened by P5 W1, P5 W4, and Stage 1 M2-C: HUB, HUB_CONNECT, HUB_DELIVERY, HUB_WRITE.
  'hub-server-gateway': "services[0] binds ServerGateway: the product Worker binds the hub's HUB → ReadGateway, HUB_CONNECT → ConnectGateway, HUB_DELIVERY → DeliveryGateway, HUB_WRITE → WriteGateway only",
  'hub-no-entrypoint': 'services[0] binds inhouse-hub with no entrypoint (its default export): bind ReadGateway',
  'hub-other-entrypoint': 'services[0].entrypoint must be ReadGateway for HUB, not "Admin"',
  'hub-second-entry': 'services must bind HUB exactly once (found 2)',
  'hub-missing': 'services must bind HUB exactly once (found 0)',
  'hub-other-service': 'services[1] binds "other-worker": the product Worker binds the hub (HUB → ReadGateway, HUB_CONNECT → ConnectGateway, HUB_DELIVERY → DeliveryGateway, HUB_WRITE → WriteGateway) only',
  'hub-binding-name': 'services[0] binds inhouse-hub as "SHOPIFY": its bindings are HUB, HUB_CONNECT, HUB_DELIVERY and HUB_WRITE',
  'hub-connect-missing': 'services must bind HUB_CONNECT exactly once (found 0)',
  'hub-connect-entrypoint': 'services[1].entrypoint must be ConnectGateway for HUB_CONNECT, not "DeliveryGateway"',
  // P5 W4 (B2, 2026-11-21): HUB_DELIVERY → DeliveryGateway joins the exact list.
  'hub-delivery-missing': 'services must bind HUB_DELIVERY exactly once (found 0)',
  'hub-delivery-entrypoint': 'services[2].entrypoint must be DeliveryGateway for HUB_DELIVERY, not "ConnectGateway"',
  // Stage 1 M2-C (N13): HUB_WRITE → WriteGateway joins the exact list.
  'hub-write-missing': 'services must bind HUB_WRITE exactly once (found 0)',
  'hub-write-entrypoint': 'services[3].entrypoint must be WriteGateway for HUB_WRITE, not "ReadGateway"',
  'sbx-name': 'config.name carries inhouse-sbx-',
  'sbx-host': 'config.vars.INHOUSE_ACCESS carries inhouse-sbx-',
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
    // The template gets this binding in #125; the test passes on a base with or without it.
    config.version_metadata ??= { binding: 'CF_VERSION_METADATA' }
    // P3 W3: the template binds AI and ships AI_GATEWAY_ID empty; the release fills it like INHOUSE_ACCESS.
    config.vars.AI_GATEWAY_ID = 'house-gateway'
    const file = join(mkdtempSync(join(tmpdir(), 'product-config-')), 'filled.json')
    writeFileSync(file, JSON.stringify(config))
    const r = run(file)
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  test('refuses wrangler.product.jsonc with INHOUSE_ACCESS filled but AI_GATEWAY_ID left empty, naming that rule only', () => {
    const config = JSON.parse(stripJsonc(readFileSync(template, 'utf8')))
    config.vars.INHOUSE_ACCESS = accessOf(`${fixtures}pass.jsonc`)
    config.version_metadata ??= { binding: 'CF_VERSION_METADATA' }
    expect(config.ai).toEqual({ binding: 'AI' })
    expect(config.vars.AI_GATEWAY_ID).toBe('')
    const file = join(mkdtempSync(join(tmpdir(), 'product-config-')), 'unfilled-gateway.json')
    writeFileSync(file, JSON.stringify(config))
    const r = run(file)
    expect(r.status).toBe(1)
    expect(r.stderr.split('\n').filter(l => l.startsWith('  - '))).toEqual([
      '  - vars.AI_GATEWAY_ID must name the AI Gateway (lowercase letters, digits and dashes): the egress calls the model through it',
    ])
  })

  test('refuses the unfilled wrangler.product.jsonc on INHOUSE_ACCESS only', () => {
    const r = run(template)
    expect(r.status).toBe(1)
    // Without #125's version_metadata binding the template also lists that rule; this test is about INHOUSE_ACCESS.
    const lines = r.stderr.split('\n').filter(l => l.startsWith('  - ') && !l.includes('version_metadata'))
    expect(lines).toEqual(['  - vars.INHOUSE_ACCESS is missing or not JSON'])
  })

  test('refuses wrangler.test.jsonc with exit 1, listing every reason', () => {
    const r = run(fileURLToPath(new URL('../wrangler.test.jsonc', import.meta.url)))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('vars.INHOUSE_TEST_BUILD is set')
    expect(r.stderr).toContain('teamDomain must be')
    expect(r.stderr).toContain('must be a bare https:// origin')
  })

  // P3 (p3-design section 13): no gateway in the test config, whatever else refuses it.
  const testConfig = () => JSON.parse(stripJsonc(readFileSync(fileURLToPath(new URL('../wrangler.test.jsonc', import.meta.url)), 'utf8')))
  const GATEWAY = 'a test-build config has an AI binding or a gateway var or secret: tests never reach the gateway'
  test('wrangler.test.jsonc has the runner pool and no gateway; adding an AI binding, a gateway var or secret is named', () => {
    expect(checkPool(testConfig())).toEqual([])
    expect(checkPool({ ...testConfig(), ai: { binding: 'AI' } })).toEqual([GATEWAY])
    const c = testConfig()
    expect(checkPool({ ...c, vars: { ...c.vars, AI_GATEWAY_ID: 'gw' } })).toEqual([GATEWAY])
    expect(checkPool({ ...c, secrets: { required: ['AI_GATEWAY_TOKEN'] } })).toEqual([GATEWAY])
    // #240 review O-L3: only the sandbox's eval mode lifts it, and only for exactly `true` on both (an exported lock).
    const gw = { ...c, ai: { binding: 'AI' } }
    for (const o of [{ sandbox: true, evalMode: 'yes' }, { sandbox: 'yes', evalMode: true }, { sandbox: 1, evalMode: 1 }, { evalMode: true }, { sandbox: true }]) {
      expect(checkPool(gw, o), JSON.stringify(o)).toEqual([GATEWAY])
    }
    expect(checkPool(gw, { sandbox: true, evalMode: true })).toEqual([])
    // The product config may name the gateway: the rule is about the test build only.
    const product = JSON.parse(stripJsonc(readFileSync(template, 'utf8')))
    expect(checkPool(product)).toEqual([])
    expect(product.vars.AI_GATEWAY_ID).toBe('')
    expect(product.secrets.required).toEqual(['AUDIT_HASH_KEY', 'AI_GATEWAY_TOKEN', 'SHOPIFY_WEBHOOK_SECRETS'])
  })
  test('the two Worker configs carry the same pool: RUNNER_POOL 2, one Runner container of standard-4 with 6 instances from ./runner/Dockerfile', () => {
    for (const c of [testConfig(), JSON.parse(stripJsonc(readFileSync(template, 'utf8')))]) {
      expect(c.vars.RUNNER_POOL).toBe('2')
      expect(c.containers).toEqual([{ class_name: 'Runner', image: './runner/Dockerfile', image_build_context: '.', instance_type: 'standard-4', max_instances: 6 }])
      expect(c.durable_objects.bindings).toEqual([{ name: 'BRAND_AGENT', class_name: 'BrandAgent' }, { name: 'RUNNER', class_name: 'Runner' }])
      expect(c.migrations).toEqual([{ tag: 'p3-v1', new_sqlite_classes: ['BrandAgent', 'Runner'] }])
      expect(c.dev).toEqual({ enable_containers: false })
    }
  })

  // P4 (p4-h1.md OC 4), widened by P5 W1, P5 W4, and Stage 1 M2-C (N13): HUB, HUB_CONNECT, HUB_DELIVERY, HUB_WRITE.
  const HUB = [
    { binding: 'HUB', service: 'inhouse-hub', entrypoint: 'ReadGateway' },
    { binding: 'HUB_CONNECT', service: 'inhouse-hub', entrypoint: 'ConnectGateway' },
    { binding: 'HUB_DELIVERY', service: 'inhouse-hub', entrypoint: 'DeliveryGateway' },
    { binding: 'HUB_WRITE', service: 'inhouse-hub', entrypoint: 'WriteGateway' },
  ]
  test('the two Worker configs bind HUB, HUB_CONNECT, HUB_DELIVERY and HUB_WRITE once each, and the hub rule passes both', () => {
    for (const c of [testConfig(), JSON.parse(stripJsonc(readFileSync(template, 'utf8')))]) {
      expect(c.services).toEqual(HUB)
      expect(checkHub(c)).toEqual([])
    }
  })
  test('the hub rule names a ServerGateway entry on any service, and a services value that is not a list', () => {
    expect(checkHub({ services: [...HUB, { binding: 'HUB_SERVER', service: 'inhouse-hub', entrypoint: 'ServerGateway' }] })).toEqual([
      "services[4] binds ServerGateway: the product Worker binds the hub's HUB → ReadGateway, HUB_CONNECT → ConnectGateway, HUB_DELIVERY → DeliveryGateway, HUB_WRITE → WriteGateway only",
    ])
    expect(checkHub({ services: [...HUB, { binding: 'OTHER', service: 'renamed-hub', entrypoint: 'ServerGateway' }] })).toEqual([
      "services[4] binds ServerGateway: the product Worker binds the hub's HUB → ReadGateway, HUB_CONNECT → ConnectGateway, HUB_DELIVERY → DeliveryGateway, HUB_WRITE → WriteGateway only",
    ])
    // Changed in the review fold (#237): another service is refused (was allowed).
    expect(checkHub({ services: [...HUB, { binding: 'OTHER', service: 'other-worker' }] })).toEqual([
      'services[4] binds "other-worker": the product Worker binds the hub (HUB → ReadGateway, HUB_CONNECT → ConnectGateway, HUB_DELIVERY → DeliveryGateway, HUB_WRITE → WriteGateway) only',
    ])
    expect(checkHub({ services: [{ ...HUB[0], props: { mode: 'server' } }, HUB[1], HUB[2], HUB[3]] })).toEqual([
      'services[0] has props: the hub entry is binding, service and entrypoint only',
    ])
    expect(checkHub({ services: { HUB: 'inhouse-hub' } })).toEqual(['services must be a list'])
  })
  test('P5 W1: each binding gets its own entrypoint, never the other one', () => {
    expect(checkHub({ services: [{ ...HUB[0], entrypoint: 'ConnectGateway' }, { ...HUB[1], entrypoint: 'ReadGateway' }, HUB[2], HUB[3]] })).toEqual([
      'services[0].entrypoint must be ReadGateway for HUB, not "ConnectGateway"',
      'services[1].entrypoint must be ConnectGateway for HUB_CONNECT, not "ReadGateway"',
    ])
    expect(checkHub({ services: [] })).toEqual([
      'services must bind HUB exactly once (found 0)',
      'services must bind HUB_CONNECT exactly once (found 0)',
      'services must bind HUB_DELIVERY exactly once (found 0)',
      'services must bind HUB_WRITE exactly once (found 0)',
    ])
    expect(checkHub({ services: [...HUB, HUB[1]] })).toEqual(['services must bind HUB_CONNECT exactly once (found 2)'])
  })
  test('P5 W4 & M2-C: HUB_DELIVERY and HUB_WRITE are each bound once with their own entrypoint', () => {
    expect(checkHub({ services: [...HUB, HUB[2]] })).toEqual(['services must bind HUB_DELIVERY exactly once (found 2)'])
    expect(checkHub({ services: [HUB[0], HUB[1], { ...HUB[2], entrypoint: 'ServerGateway' }, HUB[3]] })).toEqual([
      "services[2] binds ServerGateway: the product Worker binds the hub's HUB → ReadGateway, HUB_CONNECT → ConnectGateway, HUB_DELIVERY → DeliveryGateway, HUB_WRITE → WriteGateway only",
    ])
    expect(checkHub({ services: [HUB[0], HUB[1], { ...HUB[2], entrypoint: 'ReadGateway' }, HUB[3]] })).toEqual([
      'services[2].entrypoint must be DeliveryGateway for HUB_DELIVERY, not "ReadGateway"',
    ])
    expect(checkHub({ services: [...HUB, HUB[3]] })).toEqual(['services must bind HUB_WRITE exactly once (found 2)'])
    expect(checkHub({ services: [HUB[0], HUB[1], HUB[2], { ...HUB[3], entrypoint: 'ReadGateway' }] })).toEqual([
      'services[3].entrypoint must be WriteGateway for HUB_WRITE, not "ReadGateway"',
    ])
  })

  test('usage and an unreadable file exit 2', () => {
    expect(run().status).toBe(2)
    expect(run('a', 'b').status).toBe(2)
    expect(run(`${fixtures}does-not-exist.jsonc`).status).toBe(2)
  })
})
