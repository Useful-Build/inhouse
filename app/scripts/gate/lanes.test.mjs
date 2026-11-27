// The gate check's rules (lanes.mjs), held by example and by property. Every rule has a case that fires and a near miss
// that doesn't, so a rule that stops firing, or starts firing on a neighbour, fails here.
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { APPROVAL_LABEL, approvedHead, classify, gateChecks, parsePatch, report, scan } from './lanes.mjs'

const BENIGN = '@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3'
const file = (filename, extra = {}) => ({ filename, status: 'modified', changes: 2, patch: BENIGN, ...extra })
const added = (filename, lines, extra = {}) => file(filename, { status: 'added', patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`, ...extra })
const hunk = (removed, addedLines) => `@@ -10,${removed.length + 1} +10,${addedLines.length + 1} @@\n ctx\n${removed.map(l => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${addedLines.map(l => `+${l}`).join('\n')}`
const laneOf = files => classify({ files }).lane
const reasons = files => classify({ files }).lane4.map(i => i.reason)
const pkg = (deps, extra = {}) => JSON.stringify({ name: 'x', version: '1.0.0', ...extra, ...(deps ? { dependencies: deps } : {}) }, null, 2)
const trusted = body => ({ body, author_association: 'MEMBER' })

describe('Lane 4 paths', () => {
  const cases = [
    ['.github/workflows/ci.yml', 'the referee'],
    ['.github/rulesets/main.json', 'the referee'],
    ['.github/dependabot.yml', 'the referee'],
    ['app/playwright.config.ts', 'test config'],
    ['app/vitest.config.ts', 'test config'],
    ['app/hub/vitest.config.ts', 'test config'],
    ['app/runner/vitest.config.ts', 'test config'],
    ['AGENTS.md', 'the rules'],
    ['REVIEW.md', 'the rules'],
    ['VERIFY.md', 'the rules'],
    ['docs/decisions/0001-x.md', 'decision record'],
    ['app/server/auth/jwt.ts', 'auth'],
    ['app/hub/signin/a.ts', 'the hub'],
    ['app/hub/crypto/a.ts', 'the hub'],
    ['app/hub/scope/a.ts', 'the hub'],
    ['app/hub/testing/a.ts', 'the hub'],
    ['app/runner/src/guards/a.ts', 'the runner'],
    ['app/runner/src/proxy/a.ts', 'the runner'],
    ['app/shared/security-headers.ts', 'security headers'],
    ['app/public/_headers', 'security headers'],
    ['app/vite.config.ts', 'build seams'],
    ['app/wrangler.jsonc', 'Worker config'],
    ['app/wrangler.hub.test.jsonc', 'Worker config'],
    ['app/worker/index.ts', 'the Worker'],
    ['app/ops/backup/restore.ts', 'irreversible'],
    ['app/ops/restore/a.ts', 'irreversible'],
    ['app/ops/retention/a.ts', 'irreversible'],
    ['app/ops/export/a.ts', 'irreversible'],
    ['app/ops/delete/a.ts', 'irreversible'],
    ['app/ops/teardown/a.ts', 'irreversible'],
    ['app/package-lock.json', 'dependency change'],
    ['app/runner/harness/package-lock.json', 'dependency change'],
    ['app/scripts/sandbox/new.mjs', 'sandbox'],
  ]
  for (const [path, why] of cases) {
    test(`${path} is Lane 4 (${why}), in every status`, () => {
      for (const status of ['added', 'modified', 'removed']) {
        const r = classify({ files: [file(path, { status })] })
        expect(r.lane, `${path} ${status}`).toBe('Lane 4')
        expect(r.lane4.map(i => i.reason).join('|')).toContain(why)
      }
    })
  }
  test('a Lane 4 file renamed away is still Lane 4 (it leaves its place)', () => {
    expect(laneOf([file('old/ci.yml', { status: 'renamed', previous_filename: '.github/workflows/ci.yml' })])).toBe('Lane 4')
    expect(laneOf([file('docs/old-agents.md', { status: 'renamed', previous_filename: 'AGENTS.md' })])).toBe('Lane 4')
  })
  const nearMisses = [
    '.githubx/a.yml', 'app/.github/a.yml', 'app/server/auth.ts', 'app/server/authz/a.ts', 'app/hub/signing/a.ts',
    'app/hub/scopes/a.ts', 'app/runner/src/guardsx/a.ts', 'app/runner/guards/a.ts', 'docs/decisions.md',
    'docs/decisions-old/a.md', 'app/AGENTS.md', 'agents.md', 'docs/REVIEW.md', 'app/wrangler.json', 'app/wrangler/x.jsonc',
    'app/sub/wrangler.jsonc', 'app/worker.ts', 'app/workers/a.ts', 'app/vite.config.tsx', 'app/src/vite.config.ts',
    'app/shared/security-headers.test-data.json', 'app/public/_headersx', 'app/src/playwright.config.ts',
    'app/scriptsx/a.mjs', 'scripts/a.mjs', 'app/src/package-lock.json.md',
  ]
  test.each(nearMisses)('%s is not Lane 4', path => {
    expect(classify({ files: [file(path)] }).lane4).toEqual([])
  })
})

describe('app/scripts: existing check scripts are Lane 4, new ones are not', () => {
  test('a new file is not Lane 4', () => expect(laneOf([added('app/scripts/new-check.mjs', ['export const x = 1'])])).toBe('Lane 1/2'))
  test('a new file in a new folder is not Lane 4', () => expect(laneOf([added('app/scripts/gate2/x.mjs', ['export const x = 1'])])).toBe('Lane 1/2'))
  test('a copy into app/scripts is new', () => expect(laneOf([file('app/scripts/b.mjs', { status: 'copied', previous_filename: 'app/src/b.mjs' })])).toBe('Lane 1/2'))
  test('a move in from elsewhere is new', () => expect(laneOf([file('app/scripts/b.mjs', { status: 'renamed', previous_filename: 'app/src/b.mjs' })])).toBe('Lane 1/2'))
  for (const status of ['modified', 'removed', 'changed']) {
    test(`a ${status} existing script is Lane 4`, () => expect(reasons([file('app/scripts/check-tokens.mjs', { status })])).toContain('the referee: an existing check script'))
  }
  test('a move within app/scripts is Lane 4', () => expect(laneOf([file('app/scripts/b.mjs', { status: 'renamed', previous_filename: 'app/scripts/a.mjs' })])).toBe('Lane 4'))
  test('a move out of app/scripts is Lane 4', () => expect(laneOf([file('app/src/a.mjs', { status: 'renamed', previous_filename: 'app/scripts/a.mjs' })])).toBe('Lane 4'))
  test('a modified file in a nested folder is Lane 4', () => expect(laneOf([file('app/scripts/nightly/run.mjs')])).toBe('Lane 4'))
})

describe('check-weakening patterns in added lines, in any file', () => {
  // Each line, and the reason it must give.
  const patterns = [
    ["test.skip('x', () => {})", 'a skipped test or suite (.skip)'],
    ["  it.skip('x')", 'a skipped test or suite (.skip)'],
    ["describe.skip('x', fn)", 'a skipped test or suite (.skip)'],
    ["test.describe.skip('x', fn)", 'a skipped test or suite (.skip)'],
    ['test.describe.skip("x", () => {})', 'a skipped test or suite (.skip)'],
    ["test.fixme('x', async ({ page }) => {})", 'a skipped test or suite (.fixme)'],
    ["test.describe.fixme('x')", 'a skipped test or suite (.fixme)'],
    ['it.skip(`a ${"b"}`, fn)', 'a .skip( call (kept: a template with ${} in its arguments'],
    ['it.skip(`plain title`, fn)', 'a skipped test or suite (.skip)'],
    ['it.skip.each([1])("x")', 'a skipped test or suite (.skip)'],
    ['test.skip()', 'an unconditional skip (.skip())'],
    ['  test.skip( )', 'an unconditional skip (.skip())'],
    ['test.fixme()', 'an unconditional skip (.fixme())'],
    ["test.skip(true, 'flaky on CI')", 'an unconditional skip (.skip(true))'],
    ['test.skip(true)', 'an unconditional skip (.skip(true))'],
    ['it.skipIf(true)("x", fn)', 'an unconditional skip (.skipIf(true))'],
    ["it.skipIf('yes')('x', fn)", "a .skipIf( with a string condition (kept: always true)"],
    ['test.skip(title, async () => {})', "a skipped test whose title isn't a string literal (.skip)"],
    ["test.skip(name, 'details', fn)", "a skipped test whose title isn't a string literal (.skip)"],
    ["test.skip(..., 'x')", "a .skip( with its first argument left out (kept: can't tell it's conditional)"],
    ['test.skip(!ready, () => {})', "a skipped test whose title isn't a string literal (.skip)"],
    ["test.skip(name, async () => {", "a .skip( call (kept: its arguments run past the line"],
    ['test.skip(!cond,', 'a .skip( call (kept: its arguments run past the line'],
    ["test.skip(/firefox/.test(name), 'x')", 'a .skip( call (kept: a comment or regex in its arguments'],
    ["test.skip(a, 'x'", 'a .skip( call (kept: its arguments run past the line'],
    ["test.skip(a]", 'a .skip( call (kept: unbalanced brackets'],
    ["test.skip('unterminated, fn)", 'a .skip( call (kept: its arguments run past the line'],
    ['const s = test.skip', "a .skip used as a value (kept: can't tell it's conditional)"],
    ['run(describe.skip)', "a .skip used as a value (kept: can't tell it's conditional)"],
    ['({ fn: test.skip })', "a .skip used as a value (kept: can't tell it's conditional)"],
    ["(cond ? test : test.skip)('x', fn); test.skip('y', fn)", 'a skipped test or suite (.skip)'],
    ['// oxlint-disable-next-line no-console', 'a lint disable comment'],
    ['/* eslint-disable */', 'a lint disable comment'],
    ['# oxlint-disable', 'a lint disable comment'],
  ]
  test.each(patterns)('adds %s: Lane 4', (line, why) => {
    for (const path of ['app/src/a.ts', 'app/e2e/a.spec.ts', 'README.md', 'app/hub/x.yml']) {
      const r = classify({ files: [file(path, { patch: hunk([], [line]) })] })
      expect(r.lane, `${path}: ${line}`).toBe('Lane 4')
      expect(r.lane4[0].reason.startsWith(`check-weakening: adds ${why}`), r.lane4[0].reason).toBe(true)
      expect(r.lane4[0].reason).toMatch(/ \(line 11\)$/)
    }
  })
  // Conditional skips: a condition first, then only reason strings. VERIFY.md asks deploy-only specs for this form.
  const conditional = [
    "test.skip(!phone(page), 'the phone project only')",
    "  test.skip(!process.env.E2E_TEST_BUILD_REMOTE, 'needs the deployed build')",
    'test.skip(!process.env.E2E_TEST_BUILD_REMOTE)',
    "test.skip(browserName === 'webkit', 'no webkit')",
    "test.fixme(isMobile, 'broken on phones, issue #12')",
    "test.skip(({ browserName }) => browserName === 'firefox', 'no firefox')",
    "test.skip(cond && other(a, [1, 2]), `reason`)",
    "test.skip(false)",
    '  ;(t.seedAction ? only(...ACTIONS) : test.skip)(\'an action: listed\', async () => {',
    "(cond ? test : test.skip)('x', fn)",
    "const t = ready ? describe : describe.skip",
    "it.skipIf(win)('x', fn)",
    "describe.skipIf(process.platform === 'win32')('suite', () => {})",
    'query.skip(10).limit(5)',
    "test.skip(!phone(page), 'desktop only') // see issue",
    'gate with `test.skip(!process.env.E2E_TEST_BUILD_REMOTE, ...)` in prose',
  ]
  test.each(conditional)('adds %s: not check-weakening', line => {
    expect(laneOf([file('app/src/a.ts', { patch: hunk([], [line]) })])).toBe('Lane 1/2')
  })
  test('the #442 lines are conditional', () => {
    const lines = [
      "  test.skip(!phone(page), 'the phone project only')",
      "    ;(t.seedAction ? only(...ACTIONS) : test.skip)('an action: listed, Allow once starts the hold from the server clock, Undo takes it back, a stale answer is refused', async () => {",
      "    ;(t.seedAction && t.failNextSend ? only(...ACTIONS) : test.skip)('a send whose result is unclear needs a check, and its approver says it did not go out', async () => {",
    ]
    expect(laneOf([file('app/e2e/real/actions-ui.spec.ts', { patch: hunk([], lines) })])).toBe('Lane 3')
  })
  test('one item per line, even when two patterns match it', () => {
    expect(reasons([file('a.ts', { patch: hunk([], ["test.skip('x') // eslint-disable-line"]) })])).toHaveLength(1)
  })
  test('the same text removed or as context is not flagged', () => {
    expect(laneOf([file('app/src/a.ts', { patch: hunk(["test.skip('x')"], ["test('x')"]) })])).toBe('Lane 1/2')
    expect(laneOf([file('app/src/a.ts', { patch: "@@ -1,2 +1,2 @@\n test.skip('x')\n-a\n+b" })])).toBe('Lane 1/2')
  })
  const benign = ['skipLink()', 'const skip = 2', 'items.skipped', 'skipToContent(', 'test.only("x")', 'xit is a word', 'eslint config', '.skipper(']
  test.each(benign)('%s is not a pattern', line => expect(laneOf([file('app/src/a.ts', { patch: hunk([], [line]) })])).toBe('Lane 1/2'))
  test('the line number is the new file\'s', () => {
    const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+c\n+test.skip("x")\n d\n@@ -40,1 +41,2 @@\n e\n+// eslint-disable-line'
    expect(reasons([file('a.ts', { patch })])).toEqual(['check-weakening: adds a skipped test or suite (.skip) (line 3)', 'check-weakening: adds a lint disable comment (line 42)'])
  })
})

describe('loosened numeric settings (same key, same hunk)', () => {
  const loosened = [
    ['timeout: 5000', 'timeout: 10000'], ['timeout: 25_000', 'timeout: 30_000'], ['testTimeout: 25_000,', 'testTimeout: 60_000,'],
    ['retries: 0', 'retries: 2'], ['maxDiffPixels: 10', 'maxDiffPixels: 200'], ['maxDiffPixelRatio: 0.01', 'maxDiffPixelRatio: 0.02'],
    ['threshold: 0.2', 'threshold: 0.3'], ['{ numRuns: 1000 }', '{ numRuns: 100 }'], ['const timeout = 100', 'const timeout = 101'],
    ['expect(x).toHaveScreenshot({ maxDiffPixels: 0 })', 'expect(x).toHaveScreenshot({ maxDiffPixels: 5 })'],
  ]
  test.each(loosened)('%s -> %s is Lane 4', (before, after) => {
    const r = reasons([file('app/e2e/a.spec.ts', { patch: hunk([before], [after]) })])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/^check-weakening: \w+ (raised|lowered) from [\d.]+ to [\d.]+ \(line 11\)$/)
  })
  const fine = [
    ['timeout: 10000', 'timeout: 5000'], ['{ numRuns: 100 }', '{ numRuns: 1000 }'], ['retries: 2', 'retries: 0'],
    ['timeout: 5000', 'hookTimeout: 9000'], ['limit: 5', 'limit: 9'], ['timeout: 5000', 'timeout: 5000'],
  ]
  test.each(fine)('%s -> %s is not flagged', (before, after) => {
    expect(laneOf([file('app/src/a.ts', { patch: hunk([before], [after]) })])).toBe('Lane 1/2')
  })
  test('a new retries setting counts as raised from 0', () => {
    expect(reasons([file('app/e2e/a.spec.ts', { patch: hunk([], ['test.describe.configure({ retries: 2 })']) })])).toEqual(['check-weakening: retries raised from 0 to 2 (line 11)'])
    expect(laneOf([file('app/e2e/a.spec.ts', { patch: hunk([], ['retries: 0,']) })])).toBe('Lane 3')
  })
  test('a new timeout setting alone is not flagged', () => expect(laneOf([file('app/src/a.ts', { patch: hunk([], ['timeout: 9000']) })])).toBe('Lane 1/2'))
  test('a removed and an added setting in different hunks are not paired', () => {
    const patch = '@@ -1,2 +1,1 @@\n a\n-timeout: 5000\n@@ -50,1 +49,2 @@\n b\n+timeout: 9000'
    expect(laneOf([file('app/src/a.ts', { patch })])).toBe('Lane 1/2')
  })
  test('two settings with the same key pair in order', () => {
    expect(reasons([file('a.ts', { patch: hunk(['timeout: 10', 'timeout: 50'], ['timeout: 20', 'timeout: 50']) })])).toEqual(['check-weakening: timeout raised from 10 to 20 (line 11)'])
  })
  test('property: any raise of a loosening key is flagged, any fall is not (the reverse for numRuns)', () => {
    const key = fc.constantFrom('timeout', 'testTimeout', 'retries', 'maxDiffPixels', 'maxDiffPixelRatio', 'threshold', 'numRuns')
    fc.assert(fc.property(key, fc.nat(1_000_000), fc.nat(1_000_000), fc.constantFrom(':', ' =', ': '), (k, a, b, sep) => {
      fc.pre(a !== b)
      const r = classify({ files: [file('app/src/x.ts', { patch: hunk([`  ${k}${sep} ${a},`], [`  ${k}${sep} ${b},`]) })] })
      const loosened = k === 'numRuns' ? b < a : b > a
      expect(r.lane === 'Lane 4').toBe(loosened)
    }))
  })
})

describe('deleted tests', () => {
  test.each(['app/src/a.test.ts', 'app/e2e/b.spec.ts', 'app/scripts/c.test.mjs', 'app/src/d.property.test.ts', 'app/hub/e.test.tsx'])('removing %s is Lane 4', path => {
    expect(reasons([file(path, { status: 'removed', patch: '@@ -1 +0,0 @@\n-x' })])).toContain('check-weakening: deletes a test file')
  })
  test('removing a non-test file is not', () => expect(laneOf([file('app/src/a.ts', { status: 'removed', patch: '@@ -1 +0,0 @@\n-x' })])).toBe('Lane 1/2'))
  test('removing a test-named folder\'s non-test file is not', () => expect(laneOf([file('app/src/a.test/x.ts', { status: 'removed', patch: '@@ -1 +0,0 @@\n-x' })])).toBe('Lane 1/2'))
  test('renaming a test into a non-test name is Lane 4', () => {
    expect(reasons([file('app/src/a.ts', { status: 'renamed', previous_filename: 'app/src/a.test.ts', changes: 0, patch: undefined })])).toContain('check-weakening: deletes a test file')
  })
  test('renaming a test into another test name is not', () => {
    expect(laneOf([file('app/src/b.test.ts', { status: 'renamed', previous_filename: 'app/src/a.test.ts', changes: 0, patch: undefined })])).toBe('Lane 1/2')
  })
})

describe('package.json: a change to a dependency block is Lane 4', () => {
  const pj = (before, after, extra = {}) => file('app/package.json', { before, after, ...extra })
  test('a new dependency', () => expect(reasons([pj(pkg({ a: '1' }), pkg({ a: '1', b: '2' }))])).toContain('dependency change'))
  test('a version bump', () => expect(reasons([pj(pkg({ a: '1.0.0' }), pkg({ a: '1.0.1' }))])).toContain('dependency change'))
  test('a removed dependency', () => expect(reasons([pj(pkg({ a: '1', b: '2' }), pkg({ a: '1' }))])).toContain('dependency change'))
  test('a devDependencies change', () => expect(laneOf([pj(pkg(null, { devDependencies: { v: '1' } }), pkg(null, { devDependencies: { v: '2' } }))])).toBe('Lane 4'))
  test('an overrides change', () => expect(laneOf([pj(pkg(null, { overrides: { v: '1' } }), pkg(null, { overrides: { v: '2' } }))])).toBe('Lane 4'))
  test('a new package.json with dependencies', () => expect(laneOf([pj(null, pkg({ a: '1' }), { status: 'added' })])).toBe('Lane 4'))
  test('a new package.json with none', () => expect(laneOf([pj(null, pkg(null), { status: 'added' })])).toBe('Lane 1/2'))
  test('a removed package.json with dependencies', () => expect(laneOf([pj(pkg({ a: '1' }), null, { status: 'removed' })])).toBe('Lane 4'))
  test('nested packages count', () => {
    for (const path of ['app/hub/package.json', 'app/runner/package.json', 'app/runner/harness/package.json']) {
      expect(laneOf([file(path, { before: pkg({ a: '1' }), after: pkg({ a: '2' }) })]), path).toBe('Lane 4')
    }
  })
  test('a scripts change is Lane 4 (the lint, typecheck and test commands)', () => {
    expect(reasons([pj(pkg({ a: '1' }, { scripts: { lint: 'oxlint' } }), pkg({ a: '1' }, { scripts: { lint: 'true' } }))])).toEqual(['test or lint command change'])
    expect(reasons([pj(pkg(null, { scripts: { a: 'x' } }), pkg(null, { scripts: { a: 'x', b: 'y' } }))])).toEqual(['test or lint command change'])
    expect(reasons([pj(pkg(null, { scripts: { a: 'x' } }), pkg(null))])).toEqual(['test or lint command change'])
    expect(reasons([pj(pkg({ a: '1' }, { scripts: { a: 'x' } }), pkg({ a: '2' }, { scripts: { a: 'y' } }))])).toEqual(['dependency change', 'test or lint command change'])
  })
  test('scripts in nested packages count', () => {
    for (const path of ['app/hub/package.json', 'app/runner/package.json', 'app/runner/harness/package.json']) {
      expect(reasons([file(path, { before: pkg(null, { scripts: { test: 'vitest run' } }), after: pkg(null, { scripts: { test: 'vitest run --passWithNoTests' } }) })]), path).toEqual(['test or lint command change'])
    }
  })
  test('a new package.json with scripts is Lane 4', () => expect(reasons([pj(null, pkg(null, { scripts: { test: 'x' } }), { status: 'added' })])).toEqual(['test or lint command change']))
  test('reordering scripts, or a name or version change, is not', () => {
    expect(laneOf([pj(JSON.stringify({ scripts: { a: 'x', b: 'y' } }), JSON.stringify({ scripts: { b: 'y', a: 'x' } }))])).toBe('Lane 1/2')
    expect(laneOf([pj(pkg(null, { scripts: { a: 'x' } }), pkg(null, { scripts: { a: 'x' }, version: '2.0.0' }))])).toBe('Lane 1/2')
  })
  test('reordering dependency keys is not', () => {
    expect(laneOf([pj(JSON.stringify({ dependencies: { a: '1', b: '2' } }), JSON.stringify({ dependencies: { b: '2', a: '1' } }))])).toBe('Lane 1/2')
  })
  test('an unreadable package.json is Lane 4', () => expect(reasons([pj(pkg({ a: '1' }), '{ nope')])).toContain('dependency change: a package.json that can\'t be read'))
  test('missing texts are a crash, not a pass', () => expect(() => classify({ files: [file('app/package.json')] })).toThrow(/wasn't fetched/))
  test('package.json under node_modules is ignored', () => expect(laneOf([file('app/node_modules/x/package.json')])).toBe('Lane 1/2'))
})

describe('Lane 3 paths', () => {
  const lane3 = [
    'app/server/egress/x.ts', 'app/server/permissions/x.ts', 'app/server/outbox/x.ts', 'app/server/usage/x.ts',
    'app/server/notify-slack/x.ts', 'app/server/do/brand-agent/x.ts', 'app/hub/outbox-entry/x.ts',
    'app/hub/connectors/shopify/write/core.ts', 'app/server/prompt/x.md', 'app/e2e/a.spec.ts', 'app/e2e/support/fx.ts',
    'app/src/a.property.test.ts', 'app/hub/x.property.test.ts', 'app/server/y.property.test.ts', 'app/ops/tables/x.ts',
    'app/ops/soak/x.ts', 'app/ops/coverage/x.test.ts',
  ]
  test.each(lane3)('modified %s is Lane 3', path => expect(laneOf([file(path)])).toBe('Lane 3'))
  test.each(lane3)('added %s is Lane 3', path => expect(laneOf([added(path, ['export const x = 1'])])).toBe('Lane 3'))
  const notLane3 = ['app/server/egressx/a.ts', 'app/server/do/brand-agentx/a.ts', 'app/hub/connectors/shopify/read/a.ts', 'app/e2ex/a.ts', 'app/src/a.property.test.tsx', 'app/opsx/a.ts']
  test.each(notLane3)('%s is not Lane 3', path => expect(laneOf([file(path)])).toBe('Lane 1/2'))
  test('check-weakening in a Lane 3 file is still Lane 4', () => {
    expect(laneOf([file('app/e2e/a.spec.ts', { patch: hunk([], ["test.skip('x')"]) })])).toBe('Lane 4')
  })
})

describe('ledger items', () => {
  const migration = added('app/server/migrations/0750_x.sql', ['CREATE TABLE x (id TEXT PRIMARY KEY);'])
  test('a new migration needs two reviewer Gate check lines', () => {
    const r = classify({ files: [migration] })
    expect(r.lane).toBe('Lane 3')
    expect(r.ledger).toEqual([{ path: 'app/server/migrations/0750_x.sql', reason: 'new migration' }])
    expect(r.pass).toBe(false)
    expect(r.failures[0]).toContain('needs 2 reviewer lines starting "Gate check: on ledger" (has 0) for: app/server/migrations/0750_x.sql: new migration')
  })
  test('one line is not enough, two are', () => {
    const line = trusted('Verdict: approve\n\nGate check: on ledger (migration 0750 is in the M2 ledger)')
    expect(classify({ files: [migration], comments: [line] }).pass).toBe(false)
    expect(classify({ files: [migration], comments: [line, line] }).pass).toBe(true)
  })
  test('lines from untrusted authors don\'t count', () => {
    const outsider = { body: 'Gate check: on ledger', author_association: 'NONE' }
    const contributor = { body: 'Gate check: on ledger', author_association: 'CONTRIBUTOR' }
    expect(classify({ files: [migration], comments: [outsider, contributor, trusted('Gate check: on ledger')] }).pass).toBe(false)
  })
  test('"Gate check: off ledger" makes the items Lane 4', () => {
    const comments = [trusted('Gate check: on ledger'), trusted('Gate check: on ledger'), trusted('Gate check: off ledger: 0750 is not in the plan')]
    const r = classify({ files: [migration], comments })
    expect(r.lane).toBe('Lane 4')
    expect(r.lane4).toEqual([{ path: 'app/server/migrations/0750_x.sql', reason: 'off the ledger: new migration' }])
    expect(r.approval).toBe('missing')
    expect(classify({ files: [migration], comments, labels: [APPROVAL_LABEL], approvedDeltaFiles: [] }).pass).toBe(true)
  })
  test('routes.ts and access-matrix.ts changes are ledger items', () => {
    for (const path of ['app/server/routes.ts', 'app/server/access-matrix.ts']) {
      expect(classify({ files: [file(path)] }).ledger, path).toEqual([{ path, reason: 'route or access-matrix change' }])
    }
    expect(classify({ files: [file('app/server/routes.test.ts')] }).ledger).toEqual([])
  })
  test('a new write op is a ledger item; a changed one is only Lane 3', () => {
    expect(classify({ files: [added('app/hub/connectors/shopify/write/refund.ts', ['x'])] }).ledger).toEqual([{ path: 'app/hub/connectors/shopify/write/refund.ts', reason: 'new write op' }])
    const changed = classify({ files: [file('app/hub/connectors/shopify/write/core.ts')] })
    expect([changed.lane, changed.ledger]).toEqual(['Lane 3', []])
  })
  test('a changed existing migration is Lane 4, and so is a removed or moved one', () => {
    expect(reasons([file('app/server/migrations/0730_outbox.sql')])).toContain('irreversible: changes or removes an existing migration')
    expect(laneOf([file('app/server/migrations/0730_outbox.sql', { status: 'removed' })])).toBe('Lane 4')
    expect(laneOf([file('app/server/migrations/0731_outbox.sql', { status: 'renamed', previous_filename: 'app/server/migrations/0730_outbox.sql' })])).toBe('Lane 4')
  })
  test.each(['DROP TABLE x;', 'ALTER TABLE x DROP COLUMN y;', 'ALTER TABLE x RENAME TO y;', 'ALTER TABLE x RENAME COLUMN a TO b;', 'delete from x where 1;'])('a new migration with %s is Lane 4', sql => {
    expect(reasons([added('app/server/migrations/0750_x.sql', ['CREATE TABLE z (id TEXT);', sql])])).toEqual(['irreversible: a non-additive migration statement (line 2)'])
  })
  test('a SQL comment that mentions DROP is not', () => expect(laneOf([added('app/server/migrations/0750_x.sql', ['-- never DROP TABLE x here', 'CREATE TABLE y (id TEXT);'])])).toBe('Lane 3'))
})

describe('egress hosts', () => {
  const egress = (removed, addedLines, path = 'app/server/egress/hosts.ts') => classify({ files: [file(path, { patch: hunk(removed, addedLines) })] }).ledger
  test.each([
    ["  'api.stripe.com',", 'api.stripe.com'], ['  "https://hooks.slack.com/services",', 'hooks.slack.com'], ["  '.myshopify.com',", 'myshopify.com'],
    ["  '*.example.io',", 'example.io'], ['const u = `wss://live.example.dev:443/x`', 'live.example.dev'], ["  'https://internal.test/x',", 'internal.test'],
  ])('%s adds a host', (line, host) => expect(egress([], [line])).toEqual([{ path: 'app/server/egress/hosts.ts', reason: `adds an egress host: ${host}` }]))
  test.each(["  'egress.denied',", "import x from './x.ts'", "  'node:fs'", "  'audit.write.done',", "  'a.b'", "  'x.json'"])('%s is not a host', line => {
    expect(egress([], [line])).toEqual([])
  })
  test('a host moved between lines is not new', () => expect(egress(["  'api.stripe.com', 'b.example.com',"], ["  'api.stripe.com',", "  'b.example.com',"])).toEqual([]))
  test('a host in an egress test is not an egress host', () => expect(egress([], ["  'evil.example.com',"], 'app/server/egress/deny.test.ts')).toEqual([]))
  test('a host outside egress is not a ledger item', () => expect(egress([], ["  'api.stripe.com',"], 'app/server/other/x.ts')).toEqual([]))
})

describe('files the API gives no diff for', () => {
  test('a large text file with no patch is Lane 4 (it can\'t be scanned)', () => {
    expect(reasons([file('app/src/big.ts', { patch: undefined, changes: 5000 })])).toEqual(['no diff from the API to scan (too large): read it by hand'])
  })
  test('binary files, removals and pure renames are fine', () => {
    expect(laneOf([file('app/e2e-snaps/a.png', { patch: undefined, changes: 0 }), file('app/src/a.woff2', { patch: undefined })])).toBe('Lane 1/2')
    expect(laneOf([file('app/evals/results/x/graded.json', { patch: undefined, changes: 90000 }), file('docs/big.md', { patch: undefined })])).toBe('Lane 1/2')
    expect(laneOf([file('app/src/a.ts', { status: 'removed', patch: undefined })])).toBe('Lane 1/2')
    expect(laneOf([file('app/src/b.ts', { status: 'renamed', previous_filename: 'app/src/a.ts', patch: undefined, changes: 0 })])).toBe('Lane 1/2')
  })
  test('an incomplete file list is Lane 4', () => {
    expect(classify({ files: [], incomplete: 'the API listed 3000 of 3200 changed files' }).lane4).toEqual([{ path: '(the PR)', reason: 'file list incomplete: the API listed 3000 of 3200 changed files' }])
  })
})

describe('the approval label', () => {
  const lane4 = [file('.github/workflows/ci.yml')]
  test('Lane 4 without the label fails', () => {
    const r = classify({ files: lane4 })
    expect([r.pass, r.approval]).toEqual([false, 'missing'])
    expect(r.failures[0]).toContain(`add the ${APPROVAL_LABEL} label`)
  })
  test('the label on the same head passes', () => {
    const r = classify({ files: lane4, labels: [APPROVAL_LABEL], approvedDeltaFiles: [] })
    expect([r.pass, r.approval]).toEqual([true, 'approved'])
  })
  test('another label does not count', () => expect(classify({ files: lane4, labels: ['approved', 'wasim-approved-x'], approvedDeltaFiles: [] }).pass).toBe(false))
  test('a push with no Lane 4 item since carries the approval over', () => {
    const r = classify({ files: lane4, labels: [APPROVAL_LABEL], approvedDeltaFiles: [file('app/src/a.ts'), file('app/e2e/a.spec.ts')] })
    expect([r.pass, r.approval]).toEqual([true, 'approved (carried over: no Lane 4 item since)'])
  })
  test('a push with a Lane 4 path since makes it stale', () => {
    const r = classify({ files: lane4, labels: [APPROVAL_LABEL], approvedDeltaFiles: [file('.github/workflows/ci.yml')] })
    expect([r.pass, r.approval]).toEqual([false, 'stale'])
    expect(r.failures[0]).toBe('approval is stale: .github/workflows/ci.yml: the referee: CI workflows and repo settings; ask Wasim again and re-add the label')
  })
  test('a push with a weakening pattern since makes it stale, even in a file that is not Lane 4', () => {
    const skipped = file('app/src/a.test.ts', { patch: hunk([], ["it.skip('x')"]) })
    const r = classify({ files: [...lane4, skipped], labels: [APPROVAL_LABEL], approvedDeltaFiles: [skipped] })
    expect(r.failures[0]).toMatch(/^approval is stale: app\/src\/a\.test\.ts: check-weakening/)
  })
  test('a ledger item since is stale only when the PR is off the ledger', () => {
    const delta = [added('app/server/migrations/0751_y.sql', ['CREATE TABLE y (id TEXT);'])]
    const on = [trusted('Gate check: on ledger'), trusted('Gate check: on ledger')]
    const files = [...lane4, ...delta]
    expect(classify({ files, labels: [APPROVAL_LABEL], approvedDeltaFiles: delta, comments: on }).pass).toBe(true)
    expect(classify({ files, labels: [APPROVAL_LABEL], approvedDeltaFiles: delta, comments: [...on, trusted('Gate check: off ledger')] }).approval).toBe('stale')
  })
  test('files the PR no longer changes (main\'s, after a merge from main) don\'t count', () => {
    const fromMain = [file('.github/workflows/deploy.yml'), file('app/package-lock.json')]
    expect(classify({ files: lane4, labels: [APPROVAL_LABEL], approvedDeltaFiles: fromMain }).approval).toBe('approved (carried over: no Lane 4 item since)')
    const moved = file('app/scripts/b.mjs', { status: 'renamed', previous_filename: 'app/scripts/a.mjs' })
    expect(classify({ files: [...lane4, file('app/scripts/b.mjs')], labels: [APPROVAL_LABEL], approvedDeltaFiles: [moved] }).approval).toBe('stale')
  })
  test('no approval record is stale, with the reason', () => {
    expect(classify({ files: lane4, labels: [APPROVAL_LABEL], approvalProblem: 'the branch was force-pushed after the label was added' }).failures[0])
      .toBe('approval is stale: the branch was force-pushed after the label was added; ask Wasim again and re-add the label')
    expect(classify({ files: lane4, labels: [APPROVAL_LABEL] }).approval).toBe('stale')
  })
  test('no Lane 4 item: the label is not needed', () => {
    expect(classify({ files: [file('app/src/a.ts')] }).approval).toBe('not needed')
    expect(classify({ files: [file('app/src/a.ts')], labels: [APPROVAL_LABEL] }).approval).toBe('not needed (label present)')
  })
})

describe('approvedHead: the head when the label was added', () => {
  const commits = [
    { sha: 'a', pushedAt: '2026-11-27T10:00:00Z' },
    { sha: 'b', pushedAt: null },
    { sha: 'c', pushedAt: '2026-11-27T11:00:00Z' },
    { sha: 'd', pushedAt: '2026-11-27T13:00:00Z' },
  ]
  test('the newest commit pushed before the label', () => expect(approvedHead({ labeledAt: '2026-11-27T12:00:00Z', commits })).toEqual({ sha: 'c' }))
  test('a commit pushed at the same second counts', () => expect(approvedHead({ labeledAt: '2026-11-27T11:00:00Z', commits })).toEqual({ sha: 'c' }))
  test('inner commits of a push (no push time) are skipped', () => expect(approvedHead({ labeledAt: '2026-11-27T10:30:00Z', commits })).toEqual({ sha: 'a' }))
  test('a commit made before the label but pushed after is not approved', () => {
    expect(approvedHead({ labeledAt: '2026-11-27T12:00:00Z', commits: [{ sha: 'a', pushedAt: '2026-11-27T13:00:00Z' }] }).problem).toMatch(/no commit/)
  })
  test('no label time', () => expect(approvedHead({ labeledAt: null, commits }).problem).toMatch(/no record/))
  test('a force-push after the label', () => {
    expect(approvedHead({ labeledAt: '2026-11-27T12:00:00Z', forcePushedAt: ['2026-11-27T12:30:00Z'], commits }).problem).toBe('the branch was force-pushed after the label was added')
  })
  test('a force-push before the label is fine', () => {
    expect(approvedHead({ labeledAt: '2026-11-27T12:00:00Z', forcePushedAt: ['2026-11-27T09:00:00Z'], commits })).toEqual({ sha: 'c' })
  })
})

describe('Gate check lines', () => {
  test.each([
    'Gate check: on ledger', '> Gate check: on ledger', '- Gate check: on ledger (M2 ledger rows 3, 4)', '**Gate check: on ledger**',
    '  gate check: ON LEDGER', 'Verdict: approve\r\n\r\nGate check: on ledger',
  ])('%j counts', body => expect(gateChecks([trusted(body)]).on).toBe(1))
  test.each(['I say Gate check: on ledger', 'Gate check: on ledgers', 'Gate check: onledger', 'Gate check:'])('%j does not count', body => {
    expect(gateChecks([trusted(body)]).on).toBe(0)
  })
  test('two lines in one comment count once', () => expect(gateChecks([trusted('Gate check: on ledger\nGate check: on ledger')]).on).toBe(1))
  test('off ledger', () => expect(gateChecks([trusted('Gate check: off ledger')])).toEqual({ on: 0, off: true }))
})

describe('the report', () => {
  test('names the lane, every item and the approval state, with no em dash', () => {
    const r = classify({ files: [file('.github/workflows/ci.yml'), added('app/server/migrations/0750_x.sql', ['CREATE TABLE x (id TEXT);']), file('app/e2e/a.spec.ts')] })
    const text = report(r, { pr: '12', head: 'abcdef0123456789' })
    expect(text).toContain('## gate: Lane 4, fail')
    expect(text).toContain('PR #12 at `abcdef012345`')
    expect(text).toContain('- `.github/workflows/ci.yml`: the referee: CI workflows and repo settings')
    expect(text).toContain('- `app/server/migrations/0750_x.sql`: new migration')
    expect(text).toContain('- `app/e2e/a.spec.ts`')
    expect(text).toContain('### Approval (wasim-approved)\n- missing')
    expect(text).not.toContain('—')
  })
})

test('parsePatch tracks new-file line numbers across hunks', () => {
  expect(parsePatch('@@ -1,2 +1,3 @@\n a\n+b\n-c\n+d\n\\ No newline at end of file\n@@ -9 +10 @@\n+e')).toEqual([
    { added: [{ line: 2, text: 'b' }, { line: 3, text: 'd' }], removed: ['c'] },
    { added: [{ line: 10, text: 'e' }], removed: [] },
  ])
})

describe('properties', () => {
  const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/)
  const benignPath = fc.tuple(fc.array(segment, { minLength: 1, maxLength: 3 }), segment, fc.constantFrom('ts', 'tsx', 'css', 'md'))
    .map(([dirs, name, ext]) => `app/src/${dirs.join('/')}/${name}.${ext}`)
  const benignLine = fc.stringMatching(/^[a-z ]{0,30}$/)
  const benignFile = fc.record({ path: benignPath, status: fc.constantFrom('added', 'modified', 'removed'), lines: fc.array(benignLine, { maxLength: 4 }) })
    .map(({ path, status, lines }) => file(path, { status, patch: hunk(status === 'added' ? [] : ['old'], status === 'removed' ? [] : lines) }))
  const anyPath = fc.constantFrom(
    '.github/workflows/x.yml', 'AGENTS.md', 'app/scripts/check-tokens.mjs', 'app/scripts/new.mjs', 'app/e2e/a.spec.ts',
    'app/server/outbox/a.ts', 'app/server/routes.ts', 'app/src/a.ts', 'app/ops/backup/a.ts', 'app/ops/tables/a.ts', 'README.md',
  )
  const anyFile = fc.record({ path: anyPath, status: fc.constantFrom('added', 'modified', 'removed'), lines: fc.array(fc.oneof(benignLine, fc.constantFrom("it.skip('x')", 'retries: 3', '// eslint-disable')), { maxLength: 3 }) })
    .map(({ path, status, lines }) => file(path, { status, patch: hunk([], lines) }))
  const rank = { 'Lane 1/2': 1, 'Lane 3': 3, 'Lane 4': 4 }

  test('benign app/src changes are Lane 1/2 and pass', () => {
    fc.assert(fc.property(fc.array(benignFile, { maxLength: 8 }), files => {
      const r = classify({ files })
      expect([r.lane, r.pass]).toEqual(['Lane 1/2', true])
    }))
  })
  test('the order of the files doesn\'t change the verdict', () => {
    fc.assert(fc.property(fc.array(anyFile, { maxLength: 8 }).chain(files => fc.tuple(fc.constant(files), fc.shuffledSubarray(files, { minLength: files.length }))), ([files, shuffled]) => {
      const a = classify({ files })
      const b = classify({ files: shuffled })
      expect(b.lane).toBe(a.lane)
      expect(b.pass).toBe(a.pass)
      expect(new Set(b.lane4.map(i => `${i.path}|${i.reason}`))).toEqual(new Set(a.lane4.map(i => `${i.path}|${i.reason}`)))
    }))
  })
  test('adding a file never lowers the lane', () => {
    fc.assert(fc.property(fc.array(anyFile, { maxLength: 6 }), anyFile, (files, extra) => {
      expect(rank[laneOf([...files, extra])]).toBeGreaterThanOrEqual(rank[laneOf(files)])
    }))
  })
  test('a skipped declaration anywhere in an added line, in any file, is Lane 4', () => {
    const decl = fc.constantFrom("it.skip('x', fn)", "test.fixme('x')", "describe.skip('x', () => {})", 'test.skip()', 'test.skip(true)', '// eslint-disable', 'oxlint-disable')
    fc.assert(fc.property(fc.oneof(benignPath, anyPath), benignLine, benignLine, decl, (path, pre, post, pattern) => {
      expect(laneOf([file(path, { patch: hunk([], [`${pre} ${pattern} ${post}`]) })])).toBe('Lane 4')
    }))
  })
  test('a condition then reason strings is never check-weakening', () => {
    const ident = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/).filter(s => s !== 'true')
    const cond = fc.oneof(ident, ident.map(s => `!${s}`), fc.tuple(ident, ident).map(([a, b]) => `${a}(${b}) && !${b}.x`), ident.map(s => `process.env.${s.toUpperCase()}`))
    const reason = fc.stringMatching(/^[a-z ]{0,20}$/).map(s => `'${s}'`)
    fc.assert(fc.property(fc.constantFrom('test.skip', 'test.fixme', 'it.skipIf', 'test.describe.skip'), cond, fc.array(reason, { maxLength: 2 }), (call, c, rs) => {
      expect(laneOf([file('app/e2e/a.spec.ts', { patch: hunk([], [`  ${call}(${[c, ...rs].join(', ')})`]) })])).toBe('Lane 3')
    }))
  })
  test('any file under a Lane 4 folder is Lane 4, in any status', () => {
    const dir = fc.constantFrom('.github/', 'docs/decisions/', 'app/server/auth/', 'app/hub/signin/', 'app/runner/src/proxy/', 'app/worker/', 'app/ops/teardown/', 'app/scripts/sandbox/')
    fc.assert(fc.property(dir, fc.array(segment, { minLength: 1, maxLength: 3 }), fc.constantFrom('added', 'modified', 'removed', 'renamed'), (d, rest, status) => {
      expect(laneOf([file(`${d}${rest.join('/')}.ts`, { status, previous_filename: status === 'renamed' ? 'app/src/a.ts' : undefined })])).toBe('Lane 4')
    }))
  })
  test('scan finds an item for every Lane 4 file, and only for files in the list', () => {
    fc.assert(fc.property(fc.array(anyFile, { maxLength: 8 }), files => {
      const s = scan(files)
      const names = new Set(files.map(f => f.filename))
      for (const i of [...s.lane4, ...s.ledger]) expect(names.has(i.path)).toBe(true)
    }))
  })
})
