// The gate check's rules (lanes.mjs), held by example and by property. Every rule has a case that fires and a near miss
// that doesn't, so a rule that stops firing, or starts firing on a neighbour, fails here.
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { APPROVAL_LABEL, approvedHead, classify, evaluate, gateChecks, isTrusted, NET_LOSS_PATH, notes, parsePatch, report, scan } from './lanes.mjs'

const BENIGN = '@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3'
const file = (filename, extra = {}) => ({ filename, status: 'modified', changes: 2, patch: BENIGN, ...extra })
const added = (filename, lines, extra = {}) => file(filename, { status: 'added', patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}`, ...extra })
const hunk = (removed, addedLines) => `@@ -10,${removed.length + 1} +10,${addedLines.length + 1} @@\n ctx\n${removed.map(l => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${addedLines.map(l => `+${l}`).join('\n')}`
/** A one-hunk patch from raw diff lines (each starts with ' ', '+' or '-'), from line 1. */
const diff = lines => `@@ -1,${lines.filter(l => l[0] !== '+').length} +1,${lines.filter(l => l[0] !== '-').length} @@\n${lines.join('\n')}`
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
    ['app/.oxlintrc.json', 'lint config'],
    ['app/hub/.oxlintrc.json', 'lint config'],
    ['.eslintrc.cjs', 'lint config'],
    ['app/eslint.config.js', 'lint config'],
    ['app/oxlint.config.ts', 'lint config'],
    ['app/tsconfig.json', 'TypeScript config'],
    ['app/tsconfig.server-test.json', 'TypeScript config'],
    ['app/runner/harness/tsconfig.json', 'TypeScript config'],
    ['app/hub/tsconfig.json', 'TypeScript config'],
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
  test('the hub\'s and runner\'s scripts folders count the same way', () => {
    for (const path of ['app/runner/scripts/check-zod-major.mjs', 'app/hub/scripts/check.mjs', 'app/runner/harness/scripts/x.mjs']) {
      expect(reasons([file(path)]), path).toContain('the referee: an existing check script')
      expect(reasons([file(path, { status: 'removed' })]), path).toContain('the referee: an existing check script')
      expect(laneOf([added(path, ['export const x = 1'])]), path).toBe('Lane 1/2')
    }
    expect(laneOf([file('app/src/scripts/a.ts')])).toBe('Lane 1/2')
  })
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
    ['it.skip(`a ${"b"}`, fn)', 'a skipped test or suite (.skip)'],
    ['it.skip(`plain title`, fn)', 'a skipped test or suite (.skip)'],
    ['it.skip.each([1])("x")', 'a skipped test or suite (.skip)'],
    ["it.todo('later')", 'a todo test (.todo)'],
    ["test.todo('later')", 'a todo test (.todo)'],
    ["it.fails('x', fn)", 'an expected-to-fail test (.fails)'],
    ["test.fail('x', async () => {})", 'an expected-to-fail test (.fail)'],
    ['test.fail()', 'an unconditional skip (.fail())'],
    ['// @ts-nocheck', 'a @ts-nocheck'],
    ['test.skip()', 'an unconditional skip (.skip())'],
    ['  test.skip( )', 'an unconditional skip (.skip())'],
    ['test.fixme()', 'an unconditional skip (.fixme())'],
    ["test.skip(true, 'flaky on CI')", 'an unconditional skip (.skip(true))'],
    ['test.skip(true)', 'an unconditional skip (.skip(true))'],
    ["test.skip(1, 'x')", 'an unconditional skip (.skip(1))'],
    ['test.skip(false)', 'an unconditional skip (.skip(false))'],
    ['test.skip(!0)', 'an unconditional skip (.skip(!0))'],
    ['test.skip(null, REASON)', 'an unconditional skip (.skip(null))'],
    ['it.skipIf(true)("x", fn)', 'a .skipIf( with a literal condition (true)'],
    ['it.skipIf(1)("x", fn)', 'a .skipIf( with a literal condition (1)'],
    ["it.skipIf('yes')('x', fn)", "a .skipIf( with a literal condition ('yes')"],
    ['it.runIf(false)("x", fn)', 'a .runIf( with a literal condition (false)'],
    ['describe.runIf(0)("x", fn)', 'a .runIf( with a literal condition (0)'],
    ['it.skipIf()("x", fn)', 'a .skipIf( with a literal condition (none)'],
    ['test.skip(title, async () => {})', "a skipped test or suite (.skip) whose title isn't a string literal"],
    ["test.skip(name, 'details', fn)", "a skipped test or suite (.skip) whose title isn't a string literal"],
    ['test.skip(TITLE, function () {})', "a skipped test or suite (.skip) whose title isn't a string literal"],
    ["test.skip(..., 'x')", "a .skip( with its first argument left out (kept: can't tell it's conditional)"],
    ["test.skip(name, async () => {", "a .skip( call (kept: its arguments don't close where the diff shows them, so it can't be read as conditional)"],
    ['test.skip(!cond,', "a .skip( call (kept: its arguments don't close where the diff shows them, so it can't be read as conditional)"],
    ["test.skip(/firefox/.test(name), 'x')", "a .skip( call (kept: a comment or regex in its arguments, so it can't be read as conditional)"],
    ["test.skip(a, 'x'", "a .skip( call (kept: its arguments don't close where the diff shows them, so it can't be read as conditional)"],
    ["test.skip(a]", "a .skip( call (kept: its arguments don't close where the diff shows them, so it can't be read as conditional)"],
    ["test.skip('unterminated, fn)", "a .skip( call (kept: its arguments don't close where the diff shows them, so it can't be read as conditional)"],
    ['const s = test.skip', "a .skip used as a value (kept: can't tell it's conditional)"],
    ['run(describe.skip)', "a .skip used as a value (kept: can't tell it's conditional)"],
    ['({ fn: test.skip })', "a .skip used as a value (kept: can't tell it's conditional)"],
    ['(true ? test.skip : test)("x", fn)', 'a .skip picked by a literal condition (true)'],
    ['(1 ? test : test.skip)("x", fn)', 'a .skip picked by a literal condition (1)'],
    ["const t = 'on' ? describe.skip : describe", "a .skip picked by a literal condition ('on')"],
    ["(cond ? test : test.skip)('x', fn); test.skip('y', fn)", 'a skipped test or suite (.skip)'],
    ['// oxlint-disable-next-line no-console', 'a lint disable comment'],
    ['/* eslint-disable */', 'a lint disable comment'],
    ['# oxlint-disable', 'a lint disable comment'],
    // A condition on the CI flag alone: it skips on every CI run, which is where the checks run.
    ["test.skip(!!process.env.CI, 'flaky in CI')", 'a .skip( that always skips in CI (!!process.env.CI)'],
    ['test.skip(process.env.CI)', 'a .skip( that always skips in CI (process.env.CI)'],
    ["test.fixme(Boolean(process.env.CI), 'x')", 'a .fixme( that always skips in CI (Boolean(process.env.CI))'],
    ["test.skip(!!process.env.GITHUB_ACTIONS, 'x')", 'a .skip( that always skips in CI (!!process.env.GITHUB_ACTIONS)'],
    ["test.skip(process.env['CI'], 'x')", "a .skip( that always skips in CI (process.env['CI'])"],
    ['it.skipIf(process.env.CI)("x", fn)', 'a .skipIf( that always skips in CI (process.env.CI)'],
    ['it.runIf(!process.env.CI)("x", fn)', 'a .runIf( that always skips in CI (!process.env.CI)'],
    ["test.skip(process.env.CI === 'true', 'x')", "a .skip( on the CI flag alone (process.env.CI === 'true') (kept: can't tell which way it goes)"],
    ['describe.runIf(process.env.CI !== undefined)("x", fn)', "a .runIf( on the CI flag alone (process.env.CI !== undefined) (kept: can't tell which way it goes)"],
    ['(process.env.CI ? test.skip : test)("x", fn)', 'a .skip always picked in CI (process.env.CI)'],
    ['(!process.env.CI ? test : test.skip)("x", fn)', 'a .skip always picked in CI (!process.env.CI)'],
    ["(process.env.CI || process.env.GITHUB_ACTIONS ? test : test.skip)('x', fn)", "a .skip picked on the CI flag alone (process.env.CI || process.env.GITHUB_ACTIONS) (kept: can't tell which way it goes)"],
  ]
  test.each(patterns)('adds %s: Lane 4', (line, why) => {
    for (const path of ['app/src/a.ts', 'app/e2e/a.spec.ts', 'README.md', 'app/hub/x.yml']) {
      const r = classify({ files: [file(path, { patch: hunk([], [line]) })] })
      expect(r.lane, `${path}: ${line}`).toBe('Lane 4')
      expect(r.lane4[0].reason, line).toBe(`check-weakening: adds ${why} (line 11)`)
      expect(r.lane4[0].reason).toMatch(/ \(line 11\)$/)
    }
  })
  // Conditional skips: a first argument that isn't a literal, whatever follows it (reasons). VERIFY.md asks deploy-only
  // specs for this form.
  const conditional = [
    "test.skip(!phone(page), 'the phone project only')",
    "  test.skip(!process.env.E2E_TEST_BUILD_REMOTE, 'needs the deployed build')",
    'test.skip(!process.env.E2E_TEST_BUILD_REMOTE)',
    "test.skip(browserName === 'webkit', 'no webkit')",
    "test.fixme(isMobile, 'broken on phones, issue #12')",
    "test.skip(({ browserName }) => browserName === 'firefox', 'no firefox')",
    "test.skip(cond && other(a, [1, 2]), `reason`)",
    'test.skip(CLOSED, CLOSED_WHY)',
    '  test.skip(!asked, `the 2-hour proof runs only when named: sandbox-test-deploy -f full=true -f only="${SELF}"`)',
    '  test.skip(condition, reason)',
    '      test.skip(!!process.env.E2E_TEST_BUILD_REMOTE && bad.remoteSkip !== undefined, bad.remoteSkip)',
    "test.fail(isWebkit, 'known bug')",
    '  ;(t.seedAction ? only(...ACTIONS) : test.skip)(\'an action: listed\', async () => {',
    "(cond ? test : test.skip)('x', fn)",
    "const t = ready ? describe : describe.skip",
    "it.skipIf(win)('x', fn)",
    'it.runIf(process.env.CI)("x", fn)',
    "describe.skipIf(process.platform === 'win32')('suite', () => {})",
    'query.skip(10).limit(5)',
    'tour.skip()',
    'this.tour.skip(); steps.todo("x")',
    "test.skip(!phone(page), 'desktop only') // see issue",
    'gate with `test.skip(!process.env.E2E_TEST_BUILD_REMOTE, ...)` in prose',
    // The CI flag the other way round (the test runs in CI), with another condition, or a variable that only starts with CI.
    "test.skip(!process.env.CI, 'runs in CI only')",
    'it.skipIf(!process.env.CI)("x", fn)',
    'describe.runIf(!!process.env.CI)("x", fn)',
    "(process.env.CI ? test : test.skip)('x', fn)",
    "(!process.env.CI ? test.skip : test)('x', fn)",
    "test.skip(!!process.env.CI && !phone(page), 'x')",
    "test.skip(!process.env.CI_TOKEN, 'x')",
    "test.skip(process.env.CITY === 'x', 'x')",
  ]
  test.each(conditional)('adds %s: not check-weakening', line => {
    expect(laneOf([file('app/src/a.ts', { patch: hunk([], [line]) })])).toBe('Lane 1/2')
  })
  test('a call split over added lines is read whole', () => {
    expect(laneOf([file('app/e2e/a.spec.ts', { patch: hunk([], ['  test.skip(', '    !process.env.E2E_TEST_BUILD_REMOTE,', "    'needs the deployed build',", '  )']) })])).toBe('Lane 3')
    expect(reasons([file('app/e2e/a.spec.ts', { patch: hunk([], ['  test.skip(', "    'a title',", '    async () => {})']) })])).toEqual(['check-weakening: adds a skipped test or suite (.skip) (line 11)'])
  })
  test('a call split over an added line and context lines is read whole', () => {
    const patch = "@@ -1,3 +1,3 @@\n-  test.skip(cond,\n+  test.skip(!cond,\n     'reason',\n   )"
    expect(laneOf([file('app/e2e/a.spec.ts', { patch })])).toBe('Lane 3')
  })
  test('a call that still does not close in the hunk is flagged', () => {
    expect(reasons([file('app/e2e/a.spec.ts', { patch: hunk([], ['  test.skip(', '    !cond,']) })])).toEqual(["check-weakening: adds a .skip( call (kept: its arguments don't close where the diff shows them, so it can't be read as conditional) (line 11)"])
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
  const benign = ['tour.skip()', 'player.fixme()', 'list.todo("x")', 'skipLink()', 'const skip = 2', 'items.skipped', 'skipToContent(', 'test.only("x")', 'xit is a word', 'eslint config', '.skipper(']
  test.each(benign)('%s is not a pattern', line => expect(laneOf([file('app/src/a.ts', { patch: hunk([], [line]) })])).toBe('Lane 1/2'))
  test('the line number is the new file\'s', () => {
    const patch = '@@ -1,3 +1,4 @@\n a\n-b\n+c\n+test.skip("x")\n d\n@@ -40,1 +41,2 @@\n e\n+// eslint-disable-line'
    expect(reasons([file('a.ts', { patch })])).toEqual(['check-weakening: adds a skipped test or suite (.skip) (line 3)', 'check-weakening: adds a lint disable comment (line 42)'])
  })
})

describe('loosened numeric settings, in check files only', () => {
  const spec = 'app/e2e/a.spec.ts'
  const loosened = [
    ['timeout: 5000', 'timeout: 10000'], ['timeout: 25_000', 'timeout: 30_000'], ['testTimeout: 25_000,', 'testTimeout: 60_000,'],
    ['retries: 0', 'retries: 2'], ['retry: 0', 'retry: 3'], ['maxDiffPixels: 10', 'maxDiffPixels: 200'], ['maxDiffPixelRatio: 0.01', 'maxDiffPixelRatio: 0.02'],
    ['threshold: 0.2', 'threshold: 0.3'], ['{ numRuns: 1000 }', '{ numRuns: 100 }'], ['const timeout = 100', 'const timeout = 101'],
    ['expect(x).toHaveScreenshot({ maxDiffPixels: 0 })', 'expect(x).toHaveScreenshot({ maxDiffPixels: 5 })'],
    ['timeout: 60 * 1000', 'timeout: 2 * 60 * 1000'], ['timeout: 60_000', 'timeout: 90 * 1000'], ['test.setTimeout(60_000)', 'test.setTimeout(120_000)'],
    ['testInfo.setTimeout(1000)', 'testInfo.setTimeout(2e3)'],
  ]
  test.each(loosened)('%s -> %s is Lane 4', (before, after) => {
    const r = reasons([file(spec, { patch: hunk([before], [after]) })])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatch(/^check-weakening: [\w.]+ (raised|lowered) from .+ to .+ \(line 11\)$/)
  })
  const fine = [
    ['timeout: 10000', 'timeout: 5000'], ['{ numRuns: 100 }', '{ numRuns: 1000 }'], ['retries: 2', 'retries: 0'],
    ['timeout: 5000', 'hookTimeout: 9000'], ['limit: 5', 'limit: 9'], ['timeout: 5000', 'timeout: 5000'], ['timeout: 60 * 1000', 'timeout: 60_000'],
    ['test.setTimeout(120_000)', 'test.setTimeout(60_000)'], ['timeout: BIG', 'timeout: BIG'], ['retry: noop', 'retry: () => {}'],
    ['// timeout: 5', '// timeout: 50'], ['const ok = a === 5', 'const ok = a === 9'],
  ]
  test.each(fine)('%s -> %s is not flagged', (before, after) => {
    expect(laneOf([file(spec, { patch: hunk([before], [after]) })])).toBe('Lane 3')
  })
  test('an assignment counts only with a number', () => {
    expect(reasons([file(spec, { patch: hunk([], ['  const RETRIES = 3']) })])).toEqual([])
    expect(reasons([file(spec, { patch: hunk(['  const retries = 1'], ['  const retries = 3']) })])).toEqual(['check-weakening: retries raised from 1 to 3 (line 11)'])
    expect(reasons([file(spec, { patch: hunk(['  const timeout = 5'], ['  const timeout = pick()']) })])).toEqual([])
  })
  test('a value that changes to something that can\'t be read is flagged', () => {
    expect(reasons([file(spec, { patch: hunk(['timeout: 5000'], ['timeout: Number(process.env.T ?? 5000)']) })]))
      .toEqual(["check-weakening: timeout changed to a value that can't be read (Number(process.env.T ?? 5000)) (line 11)"])
    expect(reasons([file(spec, { patch: hunk(['timeout: T'], ['timeout: T * 2']) })])).toHaveLength(1)
  })
  test('in a new file, added lines never count: adding a test is never Lane 4', () => {
    for (const line of [
      'test.describe.configure({ retries: 2 })', '  retry: 1,', '  retry: RETRIES,', '  test.setTimeout(120_000)', '  test.setTimeout(SOAK_TIMEOUT_MS)',
      '  await expect(page).toHaveScreenshot({ maxDiffPixels: 50 })', '  maxDiffPixelRatio: 0.01,', '  threshold: 0.3,', '  fc.assert(p, { numRuns: 40 })',
      '  fc.assert(p, { numRuns: runs })', "it('x', { retry: 3 }, fn)",
    ]) {
      expect(laneOf([added(spec, [line])]), line).toBe('Lane 3')
    }
  })
  test('in a newly added test, added lines never count', () => {
    const newTest = [
      ' })', '+', "+test('new', async ({ page }) => {", '+  test.setTimeout(180_000)', '+  // a long one', "+  await expect(page).toHaveScreenshot('new.png', { maxDiffPixels: 50 })",
      '+  fc.assert(fc.property(arb, x => {', '+    expect(f(x)).toBe(x)', '+  }), { numRuns: 30 })', '+  fc.assert(', '+    fc.property(arb, check),', '+    { numRuns: runs },', '+  )', '+})',
    ]
    expect(reasons([file(spec, { patch: diff(newTest) })])).toEqual([])
    const newSuite = [
      ' })', "+test.describe('new suite', () => {", '+  test.describe.configure({ retries: 2 })', '+  test.beforeEach(async () => {', '+    test.setTimeout(120_000)', '+  })',
      "+  test('a', {", '+    retry: 3,', '+  }, async () => {', '+    if (slow) {', '+      testInfo.setTimeout(90_000)', '+    } else {', '+      testInfo.setTimeout(60_000)', '+    }', '+  })', '+})',
    ]
    expect(reasons([file(spec, { patch: diff(newSuite) })])).toEqual([])
    // The declaration forms this repo uses, with the setting on the declaring line or on its closing line.
    for (const lines of [
      ["+  test.prop([worldArb], { numRuns: 20 })('holds', async w => {", '+  })'], ["+it.prop([doc], { numRuns: 40 })('holds', d => {", '+})'],
      ["+it('x', { retry: 3 }, async () => {", '+})'], ["+it('x', async () => {", '+  await run()', '+}, { retry: 3 })'],
      ['+it.each([', '+  [1, 2],', "+])('adds %i', { retry: 2 }, (a, b) => {", '+})'], ["+describe.each(rows)('suite %s', { retry: 1 }, row => {", '+})'],
      ["+  test.describe.serial('s', () => {", '+    test.describe.configure({ retries: 1 })', '+  })'],
      // A property test under the name a file imports it by (`import { test as fcTest } from '@fast-check/vitest'`).
      ["+  fcTest.prop([fc.constantFrom(400, 401)], { numRuns: 60 })(", "+    'any refusal leaves the snapshot as it was', async status => {", '+    })'], ["+prop.prop([doc], { numRuns: 12 })('holds', d => {", '+})'],
    ]) {
      expect(reasons([file(spec, { patch: diff([" const a = 1", ...lines]) })]), lines[0]).toEqual([])
    }
  })
  test('an added line that loosens nothing is fine anywhere', () => {
    for (const line of [
      'retries: 0,', 'numRuns: 300', 'timeout: 9000', 'lowStockThreshold: 5,', 'shouldRetry: true', 'infra_retries: 3,', 'infra_retries: number', 'timeout: number;',
      '    const retry = toolOf(await ask(convo))', 'let timeout = setTimeout(fn)', '  retry: noop,', '  retry: RETRIES,', "  { retry: 'unavailable' }",
      '  { op: fc.constant(1), retry: fc.boolean() }', "  await expect(page).toHaveScreenshot('x.png', { timeout: 9000 })", '  fc.assert(p, { numRuns: 500 })',
    ]) {
      expect(laneOf([file(spec, { patch: hunk([], [line]) })]), line).toBe('Lane 3')
    }
  })
  const KEPT = ' (kept: the hunk also removes a test, so this one may be that test rewritten)'
  test('an existing test loosened through purely added lines is Lane 4 (round 2)', () => {
    const weakened = lines => reasons([file(spec, { patch: diff(lines) })])
    // A suite-wide setting dropped into an existing spec.
    expect(weakened(['+test.describe.configure({ retries: 2 })', ' ', " test('existing', async ({ page }) => {"])).toEqual(['check-weakening: retries raised from 0 to 2 (line 1)'])
    expect(weakened(['+test.describe.configure({ retries: R })', " test('existing', async ({ page }) => {"])).toEqual(["check-weakening: adds retries with a value that can't be read (R) (line 1)"])
    // Options spread over lines of an existing test.
    expect(weakened([" it('x', {", '+  retry: 3,', ' }, fn)'])).toEqual(['check-weakening: retry raised from 0 to 3 (line 2)'])
    expect(weakened(["-it('x', async () => {", "+it('x', {", '+  retry: 3,', '+}, async () => {', '   await run()', ' })'])).toEqual(['check-weakening: retry raised from 0 to 3 (line 2)'])
    // Options after the body of an existing test.
    expect(weakened([" it('x', async () => {", '   await run()', '-})', '+}, { retry: 3 })'])).toEqual(['check-weakening: retry raised from 0 to 3 (line 3)'])
    // An existing assertion rewrapped over several lines.
    expect(weakened([" test('existing', async ({ page }) => {", "-  await expect(page).toHaveScreenshot('x.png')", "+  await expect(page).toHaveScreenshot('x.png', {", '+    maxDiffPixels: 500,', '+  })']))
      .toEqual(['check-weakening: adds maxDiffPixels: 500 (line 3)'])
    // An existing multi-line property that gains its options on the closing line.
    expect(weakened([" it('holds', () => {", '   fc.assert(fc.property(arb, x => {', '     expect(f(x)).toBe(x)', '-  }))', '+  }), { numRuns: 5 })'])).toEqual(['check-weakening: adds numRuns: 5, below 100 (line 4)'])
    expect(weakened(['   fc.assert(', '     fc.property(arb, check),', '+    { numRuns: runs },', '   )'])).toEqual(["check-weakening: adds numRuns: runs, a value that can't be read (line 3)"])
    // A timeout set inside an existing test, or in a hook of an existing suite.
    expect(weakened([" test('existing', async ({ page }) => {", '+  test.setTimeout(600_000)', "   await page.goto('/')"])).toEqual(['check-weakening: adds test.setTimeout(600_000) outside a newly added test (line 2)'])
    expect(weakened([" test.describe('existing', () => {", '+  test.beforeEach(async ({}, testInfo) => {', '+    testInfo.setTimeout(SOAK_TIMEOUT_MS)', '+  })']))
      .toEqual(['check-weakening: adds testInfo.setTimeout(SOAK_TIMEOUT_MS) outside a newly added test (line 3)'])
    expect(weakened([" test('existing', async () => {", '+  test.setTimeout(', '+    600_000,'])).toEqual(['check-weakening: adds test.setTimeout(...) outside a newly added test (line 2)'])
    // A new assertion that swaps in for an existing one.
    expect(weakened([" test('existing', async ({ page }) => {", '-  await expect(a).toBeVisible()', '+  await expect(page).toHaveScreenshot({ maxDiffPixels: 5 })'])).toEqual(['check-weakening: adds maxDiffPixels: 5 (line 2)'])
  })
  test('an added test is new only when the diff shows it whole and the hunk removes no test', () => {
    const weakened = lines => reasons([file(spec, { patch: diff(lines) })])
    const timeout = line => [`check-weakening: adds test.setTimeout(600_000) outside a newly added test (line ${line})`]
    // A renamed test is the old test: its opening line is added, but the hunk removes a declaration.
    expect(weakened(["-test('a', async ({ page }) => {", "+test('a, renamed', async ({ page }) => {", '+  test.setTimeout(600_000)', "   await page.goto('/')", ' })'])).toEqual(timeout(2))
    // The same test rewritten line for line: every line of it is added, and only the removed declaration gives it away.
    expect(weakened(["-test('a', async ({ page }) => {", "-  await page.goto('/')", '-})', "+test('a, renamed', async ({ page }) => {", '+  test.setTimeout(600_000)', "+  await page.goto('/home')", '+})']))
      .toEqual([`check-weakening: adds test.setTimeout(600_000)${KEPT} (line 2)`])
    // The same hunk, further down: a test that is new can't be told from the removed one rewritten, so it's kept.
    expect(weakened(["-test('a', async () => {", "+test('a2', async () => {", '   await run()', ' })', "+test('new', async () => {", '+  fc.assert(p, { numRuns: 30 })', '+})']))
      .toEqual([`check-weakening: adds numRuns: 30, below 100${KEPT} (line 5)`])
    expect(weakened(["-  test.prop([arb])('holds', x => {", "+  test.prop([arb], { numRuns: 5 })('holds', x => {"])).toEqual(['check-weakening: adds numRuns: 5, below 100 (line 1)'])
    // Existing tests wrapped in a new suite, re-indented or not.
    expect(weakened(["-test('existing', async () => {", '-  await run()', '-})', "+test.describe('wrapper', () => {", '+  test.describe.configure({ retries: 2 })', "+  test('existing', async () => {", '+    await run()', '+  })', '+})']))
      .toEqual([`check-weakening: retries raised from 0 to 2${KEPT} (line 2)`])
    expect(weakened(["+test.describe('wrapper', () => {", " test('existing', async () => {", '+  test.setTimeout(600_000)', '   await run()'])).toEqual(timeout(3))
    // After a new test closes, the line is outside it again.
    expect(weakened([' const a = 1', "+test('new', async () => {", '+  await run()', '+})', '+test.setTimeout(600_000)'])).toEqual(timeout(5))
    expect(weakened([" describe('existing', () => {", "+  it('new', () => {", '+    run()', '+  })', '+  test.setTimeout(600_000)'])).toEqual(timeout(5))
    expect(weakened([' const a = 1', "+test('new', async () => {", '+  await run()', '+})', '+  test.setTimeout(600_000)'])).toEqual(timeout(5))
    // A new suite dropped around existing tests that weren't re-indented: its lines were there before.
    expect(weakened(["+test.describe('wrapper', () => {", '+  test.describe.configure({ retries: 2 })', " test('existing', async () => {", '   await run()', ' })', '+})'])).toEqual(['check-weakening: retries raised from 0 to 2 (line 2)'])
    expect(weakened(["+describe('wrapper', { retry: 3 }, () => {", " it('existing', () => {", '   run()', ' })', '+})'])).toEqual(['check-weakening: retry raised from 0 to 3 (line 1)'])
    // A commented-out declaration opens nothing, and nor does one named in a comment on the line itself.
    expect(weakened([" it('existing', {", "+  retry: 3, // as it('other', fn) has", ' }, fn)'])).toEqual(['check-weakening: retry raised from 0 to 3 (line 2)'])
    expect(weakened([" test('existing', async () => {", "+  // test('old', async () => {", '+    test.setTimeout(600_000)'])).toEqual(timeout(3))
    expect(weakened([' const a = 1', '+/*', "+test('old', async () => {", '+*/', '+test.setTimeout(600_000)'])).toEqual(timeout(5))
    // A line that closes more than it opened ends the reading: what follows is not inside that test.
    expect(weakened([" describe('existing', () => {", "+it('x', fn) })", '+test.describe.configure({ retries: 2 })', "+describe('next', () => {", '+})'])).toEqual(['check-weakening: retries raised from 0 to 2 (line 3)'])
    // A new test that takes a call the hunk removes from an existing one: the call may have moved, looser.
    expect(weakened([" it('existing', () => {", '-  fc.assert(p)', '+  run()', ' })', "+it('new', () => {", '+  fc.assert(p, { numRuns: 5 })', '+})'])).toEqual(['check-weakening: adds numRuns: 5, below 100 (line 5)'])
    // A test the hunk doesn't show whole, or one the reader can't follow (an unclosed quote), is not taken as new.
    expect(weakened([' const a = 1', "+test('new', async () => {", '+  test.setTimeout(600_000)', '+  await run()'])).toEqual(timeout(3))
    expect(weakened([' const a = 1', "+test('new', async () => {", '+  render(<p>Don\'t</p>)', '+  test.setTimeout(600_000)', '+})'])).toEqual(timeout(4))
    expect(weakened([' for (const c of CASES) {', "+  it('new', () => {", '+    render(<p>Don\'t</p>)', '+  })', '+  test.setTimeout(600_000)', ' }'])).toEqual(timeout(5))
  })
  test('a newly added test is read by its brackets, whatever its layout', () => {
    const fine = lines => expect(reasons([file(spec, { patch: diff(lines) })]), lines.join('\n')).toEqual([])
    // A template that runs over lines, with brackets and a `${}` in it.
    fine([' const a = 1', "+test('new', async () => {", '+  const sql = `', '+SELECT (1', '+${[a, `}`].join(")")}`', '+  test.setTimeout(600_000)', '+})'])
    // Regexes, divisions, comments and strings that hold brackets and quotes.
    fine([' const a = 1', "+test('new', async ({ page }) => {", "+  await expect(page).toHaveURL(/\\/jobs\\/[^/)]+'?$/) // it's ) fine", "+  const half = (total / 2) / parts; const s = '})' /* ( */", '+  test.setTimeout(600_000)', '+})'])
    // The call closes deeper than it opens (the layout this repo's property tests use).
    fine([' const a = 1', '+  fcTest.prop([fc.constantFrom(400, 401)], { numRuns: 60 })(', "+    'any refusal leaves the snapshot as it was', async status => {", '+      await run(status)', '+    })', '+', " test('next', () => {"])
    // The diff shows the new test's last line as context: it matched the `})` of the test above.
    fine(['   await old()', '+})', '+', "+test('new', async () => {", '+  test.setTimeout(180_000)', '+  await run()', ' })'])
    fine(['     await old()', '+  })', '+', "+  test('new', async () => {", '+    fc.assert(p, { numRuns: 30 })', '   })', ' })'])
  })
  test('a new test beside a removed line that has no declaration is not flagged', () => {
    const lines = ["-  await page.goto('/')", "+  await page.goto('/home')", ' })', "+test('new', async () => {", '+  test.setTimeout(180_000)', '+  fc.assert(p, { numRuns: 30 })', '+})']
    expect(laneOf([file(spec, { patch: diff(lines) })])).toBe('Lane 3')
  })
  test('property: a loosening line is Lane 4 in an existing test and not in a new one', () => {
    const line = fc.constantFrom(
      'test.setTimeout(600_000)', 'test.describe.configure({ retries: 2 })', "await expect(page).toHaveScreenshot('x.png', { maxDiffPixels: 50 })", 'fc.assert(p, { numRuns: 5 })',
      'maxDiffPixelRatio: 0.2,', 'retry: 3,', 'threshold: 0.5,', 'numRuns: runs,',
    )
    const opener = fc.constantFrom(
      "test('t', async ({ page }) => {", "it('t', () => {", "describe('s', () => {", "test.describe('s', () => {", "it.each(rows)('t %s', row => {", "test.prop([arb], { numRuns: 200 })('t', x => {",
    )
    const filler = fc.array(fc.constantFrom(
      'await step()', 'const a = 1', '', "// a note, don't count (this", 'if (x) { y() }', "expect(s).toMatch(/a\\/b[/)]'/)", 'const t = `a ${b ? `(${c}` : "}"} c`', 'const half = n / 2 / (m)', '/* ( */ run()',
    ), { maxLength: 4 })
    fc.assert(fc.property(line, opener, filler, fc.nat(3), (l, o, body, depth) => {
      const pad = '  '.repeat(depth)
      const block = [`${pad}${o}`, ...body.map(b => (b ? `${pad}  ${b}` : '')), `${pad}  ${l}`, `${pad}})`]
      const asNew = [' const first = 1', ...block.map(b => `+${b}`)]
      const inExisting = [` ${block[0]}`, ...block.slice(1, -1).map(b => `+${b}`), ` ${block.at(-1)}`]
      expect(laneOf([file(spec, { patch: diff(asNew) })])).toBe('Lane 3')
      expect(laneOf([added(spec, block)])).toBe('Lane 3')
      expect(laneOf([file(spec, { patch: diff(inExisting) })])).toBe('Lane 4')
    }))
  })
  test('a loosening key added to an existing call (its removed line in the same hunk) counts', () => {
    const modified = (before, after) => reasons([file(spec, { patch: hunk([before], [after]) })])
    expect(modified("  await expect(page).toHaveScreenshot('x.png')", "  await expect(page).toHaveScreenshot('x.png', { maxDiffPixels: 50 })"))
      .toEqual(['check-weakening: adds maxDiffPixels: 50 (line 11)'])
    expect(modified('  await expect(page).toHaveScreenshot()', '  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.02, threshold: 0.4 })'))
      .toEqual(['check-weakening: adds maxDiffPixelRatio: 0.02 (line 11)', 'check-weakening: adds threshold: 0.4 (line 11)'])
    expect(modified('  fc.assert(fc.property(arb, check))', '  fc.assert(fc.property(arb, check), { numRuns: 20 })')).toEqual(['check-weakening: adds numRuns: 20, below 100 (line 11)'])
    expect(modified('  fc.assert(fc.property(arb, check))', '  fc.assert(fc.property(arb, check), { numRuns: RUNS })')).toEqual(["check-weakening: adds numRuns: RUNS, a value that can't be read (line 11)"])
    expect(modified("  test.describe.configure({ mode: 'serial' })", "  test.describe.configure({ mode: 'serial', retries: 2 })")).toEqual(['check-weakening: retries raised from 0 to 2 (line 11)'])
    expect(modified('  await $.go(x)', '  await $.go(x, { retry: R })')).toEqual(["check-weakening: adds retry with a value that can't be read (R) (line 11)"])
  })
  test('a key added to an existing call that doesn\'t loosen is fine', () => {
    const modified = (before, after) => laneOf([file(spec, { patch: hunk([before], [after]) })])
    expect(modified('  fc.assert(fc.property(arb, check))', '  fc.assert(fc.property(arb, check), { numRuns: 500 })')).toBe('Lane 3')
    expect(modified("  test.describe.configure({ mode: 'serial' })", "  test.describe.configure({ mode: 'serial', retries: 0 })")).toBe('Lane 3')
    expect(modified("  await expect(page).toHaveScreenshot('x.png')", "  await expect(page).toHaveScreenshot('x.png', { timeout: 9000 })")).toBe('Lane 3')
  })
  test('product code never counts (E)', () => {
    for (const [before, after] of [['const MAX_INFRA_RETRIES = 2', 'const MAX_INFRA_RETRIES = 3'], ['busy_timeout: 5000', 'busy_timeout: 30000'], [null, 'maxDiffPixels: 9']]) {
      for (const path of ['app/server/do/x.ts', 'app/src/a.ts', 'app/runner/src/run.ts']) {
        expect(classify({ files: [file(path, { patch: hunk(before ? [before] : [], [after]) })] }).lane4, `${path}: ${after}`).toEqual([])
      }
    }
  })
  test('configs and test folders count', () => {
    for (const path of ['app/playwright.config.ts', 'app/vitest.config.ts', 'app/hub/connectors/slack/testing/kit.ts', 'app/test/upstreams/x.ts', 'app/e2e/support/fx.ts', 'app/tsconfig.json']) {
      expect(classify({ files: [file(path, { patch: hunk(['timeout: 5'], ['timeout: 50']) })] }).lane4.map(i => i.reason), path).toContain('check-weakening: timeout raised from 5 to 50 (line 11)')
    }
  })
  test('a removed and an added setting in different hunks are not paired', () => {
    const patch = '@@ -1,2 +1,1 @@\n a\n-timeout: 5000\n@@ -50,1 +49,2 @@\n b\n+timeout: 9000'
    expect(laneOf([file(spec, { patch })])).toBe('Lane 3')
  })
  test('two settings with the same key pair in order', () => {
    expect(reasons([file(spec, { patch: hunk(['timeout: 10', 'timeout: 50'], ['timeout: 20', 'timeout: 50']) })])).toEqual(['check-weakening: timeout raised from 10 to 20 (line 11)'])
  })
  test('evaluate reads numbers and products, and nothing else', () => {
    expect([evaluate('60_000'), evaluate('60 * 1000'), evaluate('2*60*1_000'), evaluate('(5) * 2'), evaluate('1e3'), evaluate('0.5')]).toEqual([60000, 60000, 120000, 10, 1000, 0.5])
    for (const e of ['T', 'T * 2', '60 + 1', 'Number(x)', '', '1 /2', '-1']) expect(evaluate(e), e).toBe(null)
  })
  test('property: any raise of a loosening key is flagged, any fall is not (the reverse for numRuns)', () => {
    const key = fc.constantFrom('timeout', 'testTimeout', 'retries', 'retry', 'maxDiffPixels', 'maxDiffPixelRatio', 'threshold', 'numRuns')
    fc.assert(fc.property(key, fc.nat(1_000_000), fc.nat(1_000_000), fc.constantFrom(':', ' =', ': '), fc.boolean(), (k, a, b, sep, product) => {
      fc.pre(a !== b)
      const v = n => (product ? `${n} * 1` : `${n}`)
      const r = classify({ files: [file(spec, { patch: hunk([`  ${k}${sep} ${v(a)},`], [`  ${k}${sep} ${v(b)},`]) })] })
      const loosened = k === 'numRuns' ? b < a : b > a
      expect(r.lane === 'Lane 4').toBe(loosened)
    }))
  })
})

describe('net loss of tests', () => {
  const t = (path, removed, addedLines) => file(path, { patch: hunk(removed, addedLines) })
  test('more test, it and describe declarations removed than added is Lane 4', () => {
    const r = classify({ files: [t('app/src/a.test.ts', ["test('a', () => {})", "it('b', () => {})"], ["test('a', () => {})"])] })
    expect(r.lane4).toEqual([{ path: NET_LOSS_PATH, reason: 'check-weakening: net loss of tests (2 test, it or describe declarations removed, 1 added)' }])
  })
  test('tests moved between files net out', () => {
    expect(laneOf([t('app/src/a.test.ts', ["test('a', fn)", "describe('s', fn)"], []), t('app/src/b.test.ts', [], ["test('a', fn)", "test.describe('s', fn)"])])).toBe('Lane 1/2')
  })
  test('a test rewritten in place is not a loss', () => expect(laneOf([t('app/e2e/a.spec.ts', ["test('a', async ({ page }) => {"], ["test('a, renamed', async ({ page }) => {"])])).toBe('Lane 3'))
  test('property, table and conditional declarations count too', () => {
    const lost = ["test.prop([arb], { numRuns: 200 })('holds', x => {", "it.each(rows)('adds %i', row => {", "describe.skipIf(win)('suite', () => {", "it.prop([doc])('holds', d => {", "fcTest.prop([doc])('holds', d => {"]
    expect(reasons([t('app/src/a.test.ts', lost, ["it('one', fn)"])])).toEqual(['check-weakening: net loss of tests (5 test, it or describe declarations removed, 1 added)'])
    expect(laneOf([t('app/src/a.test.ts', lost, lost)])).toBe('Lane 1/2')
    expect(laneOf([t('app/src/a.test.ts', ['test.describe.configure({ mode: "serial" })', 'test.setTimeout(5)', 'it.next()', 'test.info()', 'a.b.prop(x)', 'el.props(x)'], [])])).toBe('Lane 1/2')
  })
  test('only test files count', () => expect(laneOf([t('docs/a.md', ["test('a', fn)", "test('b', fn)"], [])])).toBe('Lane 1/2'))
  test('turning a test into a skipped one is a loss (and a skip)', () => {
    expect(reasons([t('app/src/a.test.ts', ["it('a', fn)"], ["it.skip('a', fn)"])])).toEqual([
      'check-weakening: adds a skipped test or suite (.skip) (line 11)',
      'check-weakening: net loss of tests (1 test, it or describe declarations removed, 0 added)',
    ])
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
  test('a new or changed write op is a ledger item; its tests are not', () => {
    expect(classify({ files: [added('app/hub/connectors/shopify/write/refund.ts', ['x'])] }).ledger).toEqual([{ path: 'app/hub/connectors/shopify/write/refund.ts', reason: 'new write op' }])
    expect(classify({ files: [file('app/hub/connectors/shopify/write/core.ts')] }).ledger).toEqual([{ path: 'app/hub/connectors/shopify/write/core.ts', reason: 'write op change' }])
    expect(classify({ files: [file('app/hub/connectors/shopify/write/core.ts', { status: 'removed' })] }).ledger[0].reason).toBe('write op change')
    expect(classify({ files: [added('app/server/outbox/operations/refund.ts', ['x'])] }).ledger).toEqual([{ path: 'app/server/outbox/operations/refund.ts', reason: 'new write op' }])
    expect(classify({ files: [file('app/server/outbox/operations/slack-channel-post.ts')] }).ledger[0].reason).toBe('write op change')
    for (const path of ['app/hub/connectors/shopify/write/core.test.ts', 'app/server/outbox/operations/operations.test.ts', 'app/hub/connectors/x/write/testing/kit.ts']) {
      expect(classify({ files: [file(path)] }).ledger, path).toEqual([])
    }
    expect(classify({ files: [file('app/server/outbox/dispatch.ts')] }).ledger).toEqual([])
  })
  test('a changed existing migration is Lane 4, and so is a removed or moved one', () => {
    expect(reasons([file('app/server/migrations/0730_outbox.sql')])).toContain('irreversible: changes or removes an existing migration')
    expect(laneOf([file('app/server/migrations/0730_outbox.sql', { status: 'removed' })])).toBe('Lane 4')
    expect(laneOf([file('app/server/migrations/0731_outbox.sql', { status: 'renamed', previous_filename: 'app/server/migrations/0730_outbox.sql' })])).toBe('Lane 4')
  })
  test.each([
    'DROP TABLE x;', 'ALTER TABLE x DROP COLUMN y;', 'ALTER TABLE x RENAME TO y;', 'ALTER TABLE x RENAME COLUMN a TO b;', 'delete from x where 1;',
    "UPDATE x SET a = 'b';", '  DROP INDEX i;', 'REFERENCES y(id) ON DELETE CASCADE',
  ])('a new migration with %s is Lane 4', sql => {
    expect(reasons([added('app/server/migrations/0750_x.sql', ['CREATE TABLE z (id TEXT);', sql])])).toEqual(['irreversible: non-additive migration (line 2)'])
  })
  test('the rule covers every file under migrations, not only .sql', () => {
    expect(reasons([added('app/server/migrations/README.txt', ['UPDATE rows by hand'])])).toContain('irreversible: non-additive migration (line 1)')
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
  test('a host outside egress code is not a ledger item', () => expect(egress([], ["  'api.stripe.com',"], 'app/server/other/x.ts')).toEqual([]))
  test('hub connectors are egress code too', () => {
    expect(egress([], ["    allowedHosts: ['mcp.slack.com', 'slack.com', 'files.slack.com'],"], 'app/hub/connectors/mcp/slack/route.ts')).toEqual([
      { path: 'app/hub/connectors/mcp/slack/route.ts', reason: 'adds an egress host: files.slack.com, mcp.slack.com, slack.com' },
      { path: 'app/hub/connectors/mcp/slack/route.ts', reason: 'changes a host list line (allowedHosts, hosts or HOSTS)' },
    ])
    expect(egress(["export const SLACK_API_HOSTS = ['slack.com'] as const"], ["export const SLACK_API_HOSTS = ['slack.com', 'files.slack.com'] as const"], 'app/hub/connectors/slack/web.ts'))
      .toEqual([
        { path: 'app/hub/connectors/slack/web.ts', reason: 'adds an egress host: files.slack.com' },
        { path: 'app/hub/connectors/slack/web.ts', reason: 'changes a host list line (allowedHosts, hosts or HOSTS)' },
      ])
  })
  test('a host list line that changes without a literal host is a ledger item', () => {
    for (const line of ['    allowedHosts: [NOTES_HOST, OTHER_HOST],', '  if (mcp.hosts.includes(url.host)) return x', 'const HOSTS = [...base, extra]']) {
      expect(egress([], [line], 'app/hub/connectors/mcp/client.ts'), line).toEqual([{ path: 'app/hub/connectors/mcp/client.ts', reason: 'changes a host list line (allowedHosts, hosts or HOSTS)' }])
    }
    expect(egress(['    allowedHosts: [A, B],'], ['    allowedHosts: [A],'], 'app/server/egress/x.ts')).toHaveLength(1)
  })
  test('connector tests and testing kits are not egress code', () => {
    expect(egress([], ["  allowedHosts: ['evil.example.com'],"], 'app/hub/connectors/mcp/slack/route.test.ts')).toEqual([])
    expect(egress([], ["  allowedHosts: ['evil.example.com'],"], 'app/hub/connectors/slack/testing/kit.ts')).toEqual([])
  })
})

describe('Dockerfiles: install lines are a dependency change', () => {
  const docker = (patch, path = 'app/runner/Dockerfile') => classify({ files: [file(path, { patch })] }).lane4.map(i => i.reason)
  const DEP = 'dependency change: a Dockerfile install line'
  test.each([
    ['RUN npm ci --no-audit --no-fund', 'RUN npm ci --no-audit --no-fund --ignore-scripts'],
    ['RUN apt-get update && apt-get install -y curl', 'RUN apt-get update && apt-get install -y curl git'],
    [null, 'RUN apk add --no-cache git'],
    [null, 'RUN pip install requests'],
    [null, 'RUN pip3 install requests'],
    ['RUN npm install -g x', null],
  ])('%s -> %s is Lane 4', (before, after) => {
    expect(docker(hunk(before ? [before] : [], after ? [after] : []))).toEqual([DEP])
  })
  test('a package added on a continuation line of an install', () => {
    const patch = '@@ -25,4 +25,5 @@\n RUN apt-get update \\\n   && apt-get install -y --no-install-recommends \\\n     ca-certificates \\\n+    git \\\n     curl'
    expect(docker(patch)).toEqual([DEP])
  })
  test('a hunk that starts inside an instruction it can\'t see is flagged', () => {
    expect(docker('@@ -30,2 +30,3 @@\n     curl \\\n+    git \\\n     jq')).toEqual([DEP])
  })
  test('other instructions are not', () => {
    expect(docker(hunk(['ENV A=1'], ['ENV A=2']))).toEqual([])
    expect(docker(hunk(['RUN chown -R root:root /opt/runner'], ['RUN chown -R root:root /opt/runner /opt/x']))).toEqual([])
    expect(docker('@@ -1,3 +1,3 @@\n RUN npm ci\n-COPY a b\n+COPY a c')).toEqual([])
  })
  test('any Dockerfile counts, but not .dockerignore', () => {
    expect(docker(hunk([], ['RUN npm ci']), 'app/hub/Dockerfile.test')).toEqual([DEP])
    expect(docker(hunk([], ['npm ci']), 'app/runner/Dockerfile.dockerignore')).toEqual([])
  })
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
  test('the label without a line naming the head fails, and says what to add', () => {
    const r = classify({ files: lane4, labels: [APPROVAL_LABEL], approvalNeedsLine: true })
    expect([r.pass, r.approval]).toEqual([false, 'no approved head named'])
    expect(r.failures[0]).toBe('add the line `wasim-approved: <sha>` naming the approved head (in a PR comment made at or after the label)')
    expect(classify({ files: lane4, labels: [APPROVAL_LABEL] }).approval).toBe('no approved head named')
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
  test('an approval problem is stale, with the reason', () => {
    expect(classify({ files: lane4, labels: [APPROVAL_LABEL], approvalProblem: 'the base branch changed after the label was added' }).failures[0])
      .toBe('approval is stale: the base branch changed after the label was added; ask Wasim again and re-add the label')
  })
  test('no Lane 4 item: the label is not needed', () => {
    expect(classify({ files: [file('app/src/a.ts')] }).approval).toBe('not needed')
    expect(classify({ files: [file('app/src/a.ts')], labels: [APPROVAL_LABEL] }).approval).toBe('not needed (label present)')
  })
})

describe('approvedHead: the head a wasim-approved line names', () => {
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const C = 'cccccccccccccccccccccccccccccccccccccccc'
  const commitShas = [A, B]
  const say = (body, at, association = 'MEMBER') => ({ body, at, author_association: association })
  const labeledAt = '2026-11-27T12:00:00Z'
  test('the SHA on a trusted line made after the label', () => {
    expect(approvedHead({ labeledAt, commitShas, comments: [say(`Wasim said yes in chat.\n\nwasim-approved: ${A}`, '2026-11-27T12:05:00Z')] })).toEqual({ sha: A })
  })
  test('a line made at the same second as the label counts', () => {
    expect(approvedHead({ labeledAt, commitShas, comments: [say(`wasim-approved: ${A}`, labeledAt)] })).toEqual({ sha: A })
  })
  test('the latest line wins', () => {
    const comments = [say(`wasim-approved: ${B}`, '2026-11-27T12:30:00Z'), say(`wasim-approved: ${A}`, '2026-11-27T12:10:00Z')]
    expect(approvedHead({ labeledAt, commitShas, comments })).toEqual({ sha: B })
  })
  test('upper-case hex, and list or emphasis marks, are fine', () => {
    expect(approvedHead({ labeledAt, commitShas, comments: [say(`- **wasim-approved: ${A.toUpperCase()}**`, '2026-11-27T12:05:00Z')] })).toEqual({ sha: A })
  })
  test('no line, or only lines that don\'t count, needs a line', () => {
    const ignored = [
      say(`wasim-approved: ${A}`, '2026-11-27T11:59:59Z'),
      say(`wasim-approved: ${A}`, '2026-11-27T12:05:00Z', 'NONE'),
      say(`> wasim-approved: ${A}`, '2026-11-27T12:05:00Z'),
      say(`I'd write wasim-approved: ${A}`, '2026-11-27T12:05:00Z'),
      say(`wasim-approved: ${A.slice(0, 12)}`, '2026-11-27T12:05:00Z'),
      say(`wasim-approved: ${A}0`, '2026-11-27T12:05:00Z'),
      say(`wasim-approved: ${A}`, null),
    ]
    expect(approvedHead({ labeledAt, commitShas, comments: ignored })).toEqual({ needsLine: true })
  })
  test('a SHA that is not a commit in the PR is a problem', () => {
    expect(approvedHead({ labeledAt, commitShas, comments: [say(`wasim-approved: ${C}`, '2026-11-27T12:05:00Z')] }).problem).toBe("the approved SHA cccccccccccc isn't a commit in this PR")
  })
  test('a base change after the label is a problem; before it is fine', () => {
    const comments = [say(`wasim-approved: ${A}`, '2026-11-27T12:05:00Z')]
    expect(approvedHead({ labeledAt, commitShas, comments, baseChangedAt: ['2026-11-27T12:30:00Z'] }).problem).toBe('the base branch changed after the label was added')
    expect(approvedHead({ labeledAt, commitShas, comments, baseChangedAt: ['2026-11-27T09:00:00Z'] })).toEqual({ sha: A })
  })
  test('no label time', () => expect(approvedHead({ labeledAt: null, commitShas }).problem).toMatch(/no record/))
  test('more commits than the API lists fails closed (J)', () => {
    const comments = [say(`wasim-approved: ${A}`, '2026-11-27T12:05:00Z')]
    expect(approvedHead({ labeledAt, commitShas, comments, commitCount: 251 }).problem)
      .toBe("the PR has 251 commits but the API lists only 2, so the approved SHA can't be checked")
    expect(approvedHead({ labeledAt, commitShas, comments, commitCount: 2 })).toEqual({ sha: A })
  })
})

describe('notes: the comments and reviews whose lines can count', () => {
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const comment = (body, created_at = '2026-11-27T12:05:00Z') => ({ body, author_association: 'MEMBER', created_at })
  const review = (state, body, submitted_at = '2026-11-27T12:05:00Z') => ({ state, body, author_association: 'MEMBER', submitted_at })
  test('comments and standing reviews are kept, with their time', () => {
    expect(notes([comment('a', '2026-11-27T10:00:00Z')], [review('APPROVED', 'b', '2026-11-27T11:00:00Z'), review('COMMENTED', null), review('CHANGES_REQUESTED', 'd')])).toEqual([
      { body: 'a', author_association: 'MEMBER', login: null, at: '2026-11-27T10:00:00Z' }, { body: 'b', author_association: 'MEMBER', login: null, at: '2026-11-27T11:00:00Z' },
      { body: '', author_association: 'MEMBER', login: null, at: '2026-11-27T12:05:00Z' }, { body: 'd', author_association: 'MEMBER', login: null, at: '2026-11-27T12:05:00Z' },
    ])
  })
  test('a dismissed review\'s Gate check line no longer counts', () => {
    const line = 'Gate check: on ledger'
    expect(gateChecks(notes([comment(line)], [review('APPROVED', line)])).on).toBe(2)
    expect(gateChecks(notes([comment(line)], [review('DISMISSED', line)])).on).toBe(1)
    expect(gateChecks(notes([], [review('DISMISSED', 'Gate check: off ledger')])).off).toBe(false)
    const migration = [added('app/server/migrations/0750_x.sql', ['CREATE TABLE x (id TEXT);'])]
    expect(classify({ files: migration, comments: notes([comment(line)], [review('APPROVED', line)]) }).pass).toBe(true)
    expect(classify({ files: migration, comments: notes([comment(line)], [review('DISMISSED', line)]) }).pass).toBe(false)
  })
  test('a dismissed review\'s wasim-approved line no longer counts', () => {
    const args = { labeledAt: '2026-11-27T12:00:00Z', commitShas: [A] }
    expect(approvedHead({ ...args, comments: notes([], [review('COMMENTED', `wasim-approved: ${A}`)]) })).toEqual({ sha: A })
    expect(approvedHead({ ...args, comments: notes([], [review('DISMISSED', `wasim-approved: ${A}`)]) })).toEqual({ needsLine: true })
  })
  test('a review that isn\'t submitted yet, or in a state the gate doesn\'t know, doesn\'t count', () => {
    expect(notes([], [review('PENDING', 'Gate check: on ledger', undefined), review('SOMETHING_NEW', 'Gate check: on ledger'), { body: 'Gate check: on ledger', author_association: 'MEMBER' }])).toEqual([])
  })
})

describe('Gate check lines', () => {
  test.each([
    'Gate check: on ledger', '- Gate check: on ledger (M2 ledger rows 3, 4)', '**Gate check: on ledger**',
    '  gate check: ON LEDGER', 'Verdict: approve\r\n\r\nGate check: on ledger',
  ])('%j counts', body => expect(gateChecks([trusted(body)]).on).toBe(1))
  test.each(['I say Gate check: on ledger', 'Gate check: on ledgers', 'Gate check: onledger', 'Gate check:', '> Gate check: on ledger', '  > Gate check: on ledger', '>Gate check: on ledger'])('%j does not count', body => {
    expect(gateChecks([trusted(body)]).on).toBe(0)
  })
  test('two lines in one comment count once', () => expect(gateChecks([trusted('Gate check: on ledger\nGate check: on ledger')]).on).toBe(1))
  test('off ledger', () => expect(gateChecks([trusted('Gate check: off ledger')])).toEqual({ on: 0, off: true }))
  test('a quoted off-ledger line does not count either', () => expect(gateChecks([trusted('> Gate check: off ledger')])).toEqual({ on: 0, off: false }))
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
    expect(text).toContain('### Approval (the wasim-approved label plus a `wasim-approved: <sha>` line)\n- missing')
    expect(report(r, { approvedSha: 'abcdef0123456789' })).toContain('- approved head: `abcdef012345`')
    expect(text).not.toContain('—')
  })
})

test('parsePatch tracks new-file line numbers across hunks', () => {
  const hunks = parsePatch('@@ -1,2 +1,3 @@\n a\n+b\n-c\n+d\n\\ No newline at end of file\n@@ -9 +10 @@\n+e')
  expect(hunks.map(h => ({ added: h.added, removed: h.removed }))).toEqual([
    { added: [{ line: 2, text: 'b' }, { line: 3, text: 'd' }], removed: ['c'] },
    { added: [{ line: 10, text: 'e' }], removed: [] },
  ])
  expect(hunks[0].lines).toEqual([{ line: 1, text: 'a', added: false }, { line: 2, text: 'b', added: true }, { line: 3, text: 'd', added: true }])
  expect(hunks[0].old).toEqual([{ text: 'a', removed: false }, { text: 'c', removed: true }])
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
  test('a condition then at most one reason is never check-weakening', () => {
    const ident = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,8}$/).filter(s => !['true', 'false', 'null', 'undefined'].includes(s))
    const cond = fc.oneof(ident, ident.map(s => `!${s}`), fc.tuple(ident, ident).map(([a, b]) => `${a}(${b}) && !${b}.x`), ident.filter(s => s.toUpperCase() !== 'CI').map(s => `process.env.${s.toUpperCase()}`))
    const reason = fc.stringMatching(/^[a-z ]{0,20}$/).map(s => `'${s}'`)
    fc.assert(fc.property(fc.constantFrom('test.skip', 'test.fixme', 'it.skipIf', 'test.describe.skip'), cond, fc.array(fc.oneof(reason, ident), { maxLength: 1 }), (call, c, rs) => {
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

// The built-in GITHUB_TOKEN can't see private org membership, so it reports a private member's comments as
// CONTRIBUTOR (seen on #457, 2026-11-27). run.mjs then checks the author's repo permission and marks the note trusted.
describe('trust by repo permission: a private org member', () => {
  const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const asContributor = (body, extra = {}) => ({ body, author_association: 'CONTRIBUTOR', login: 'owner', at: '2026-11-27T12:05:00Z', ...extra })
  test('isTrusted: a trusted association, or the permission mark, and nothing else', () => {
    expect(isTrusted({ author_association: 'MEMBER' })).toBe(true)
    expect(isTrusted({ author_association: 'CONTRIBUTOR', trusted: true })).toBe(true)
    expect(isTrusted({ author_association: 'CONTRIBUTOR' })).toBe(false)
    expect(isTrusted({ author_association: 'NONE', trusted: false })).toBe(false)
    expect(isTrusted({ author_association: 'NONE', trusted: 'yes' })).toBe(false)
  })
  test('a wasim-approved line counts once the author is marked trusted, and not before', () => {
    const args = { labeledAt: '2026-11-27T12:00:00Z', commitShas: [A] }
    expect(approvedHead({ ...args, comments: [asContributor(`wasim-approved: ${A}`)] })).toEqual({ needsLine: true })
    expect(approvedHead({ ...args, comments: [asContributor(`wasim-approved: ${A}`, { trusted: true })] })).toEqual({ sha: A })
  })
  test('Gate check lines count once the author is marked trusted, and not before', () => {
    const line = 'Gate check: on ledger'
    expect(gateChecks([asContributor(line), asContributor(line)]).on).toBe(0)
    expect(gateChecks([asContributor(line, { trusted: true }), asContributor(line, { trusted: true })]).on).toBe(2)
  })
  test('notes keeps the author login for the permission check', () => {
    expect(notes([{ body: 'x', author_association: 'CONTRIBUTOR', user: { login: 'owner' }, created_at: '2026-11-27T12:05:00Z' }], [])[0].login).toBe('owner')
  })
})
