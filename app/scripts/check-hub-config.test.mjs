// The hub config check's own tests (Node's built-in runner, no dependencies). Run in app/:
//   node --test scripts/check-hub-config.test.mjs
// Each fixture breaks one rule (a custom domain also sets `routes`) and must fail with exactly the rules listed here; the
// passing fixture and the hub's template must pass; the hub's test config must fail. Runs the script as CI does.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const app = fileURLToPath(new URL('..', import.meta.url))
const FIXTURES = 'scripts/check-hub-config-fixtures'

const EXPECTED = {
  'pass.jsonc': [],
  'fail-routes.jsonc': ['routes'],
  'fail-routes-empty.jsonc': ['routes'],
  'fail-route.jsonc': ['route'],
  'fail-custom-domain.jsonc': ['routes', 'custom-domain'],
  'fail-workers-dev-missing.jsonc': ['workers-dev'],
  'fail-workers-dev-true.jsonc': ['workers-dev'],
  'fail-preview-urls-missing.jsonc': ['preview-urls'],
  'fail-triggers.jsonc': ['triggers'],
  'fail-assets.jsonc': ['public-surface'],
  'fail-site.jsonc': ['public-surface'],
  'fail-env.jsonc': ['env'],
  'fail-test-define.jsonc': ['test-define'],
  'fail-test-define-missing.jsonc': ['test-define'],
  'fail-test-build-var.jsonc': ['test-build-var'],
  'fail-secret-hub-token-keys.jsonc': ['secret-in-vars'],
  'fail-secret-client-secret.jsonc': ['secret-in-vars'],
  'fail-secret-define-hub-token-keys.jsonc': ['secret-in-define'],
  'fail-secret-define-client-secret.jsonc': ['secret-in-define'],
  'fail-secret-define-process-env.jsonc': ['secret-in-define'],
  'fail-secret-define-env-dot.jsonc': ['secret-in-define'],
  'fail-unknown-var.jsonc': ['unknown-var'],
  'fail-secret-slack-client-secret.jsonc': ['secret-in-vars'],
  'fail-secret-shopify-write-client-secret.jsonc': ['secret-in-vars'],
  'fail-alias.jsonc': ['bundler'],
  'fail-no-bundle.jsonc': ['bundler'],
  'fail-build.jsonc': ['bundler'],
  'fail-secrets-required-missing.jsonc': ['secrets-required'],
  'fail-secrets-required-partial.jsonc': ['secrets-required'],
  'fail-signin-binding.jsonc': ['signin-binding'],
  'fail-signin-binding-script.jsonc': ['signin-binding'],
  'fail-signin-migration.jsonc': ['signin-migration'],
  'fail-main.jsonc': ['main'],
  // Stage 1 M2-C: the write-scoped Shopify SignIn's binding and its v2 migration, together.
  'fail-write-signin-binding.jsonc': ['write-signin-binding'],
  'fail-write-signin-binding-script.jsonc': ['write-signin-binding'],
  'fail-write-signin-migration.jsonc': ['write-signin-migration'],
  'fail-write-signin-migration-kv.jsonc': ['write-signin-migration'],
  'fail-write-signin-migration-tag.jsonc': ['write-signin-migration'],
  // P5 W2: code mode's loader.
  'fail-worker-loaders-two.jsonc': ['worker-loaders'],
  'fail-worker-loaders-name.jsonc': ['worker-loaders'],
  'fail-worker-loaders-extra-key.jsonc': ['worker-loaders'],
  'fail-worker-loaders-not-array.jsonc': ['worker-loaders'],
  'fail-worker-loaders-empty.jsonc': ['worker-loaders'],
}

const run = path => {
  const r = spawnSync(process.execPath, ['scripts/check-hub-config.mjs', path], { cwd: app, encoding: 'utf8' })
  const rules = [...r.stderr.matchAll(/^ {4}([a-z-]+):/gm)].map(m => m[1])
  return { status: r.status, rules: [...new Set(rules)].sort(), out: r.stdout + r.stderr }
}

test('every fixture on disk has an expectation, and every expectation a fixture', () => {
  assert.deepEqual(readdirSync(join(app, FIXTURES)).sort(), Object.keys(EXPECTED).sort())
})

for (const [file, rules] of Object.entries(EXPECTED)) {
  test(`${file} ${rules.length ? `fails exactly ${rules.join(', ')}` : 'passes'}`, () => {
    const r = run(`${FIXTURES}/${file}`)
    assert.equal(r.status, rules.length ? 1 : 0, r.out)
    assert.deepEqual(r.rules, [...rules].sort(), r.out)
  })
}

test('the hub template passes', () => {
  const r = run('wrangler.hub.jsonc')
  assert.equal(r.status, 0, r.out)
})

test('the hub test config fails (the test build can never pass as deployable)', () => {
  const r = run('wrangler.hub.test.jsonc')
  assert.equal(r.status, 1, r.out)
  assert.deepEqual(r.rules, ['secret-in-vars', 'secrets-required', 'test-build-var', 'test-define'], r.out)
})

test('an unreadable file exits 2, never 0 or 1', () => {
  assert.equal(run(`${FIXTURES}/does-not-exist.jsonc`).status, 2)
})
