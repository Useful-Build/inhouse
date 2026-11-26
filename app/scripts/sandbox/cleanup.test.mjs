// scripts/cleanup.mjs and lib/teardown.mjs. Ways they could fail, written down first:
//  1. a live product's resource, the candidate's, or the shared sandbox's is deleted;
//  2. an open PR's deployment, or one whose state couldn't be read, is deleted;
//  3. a per-PR-shaped name this tool never makes (inhouse-sbx-pr15-x) is deleted, by prefix;
//  4. a custom domain on a PR's Worker but with a foreign hostname is detached;
//  5. a bucket is deleted before it's empty, a dry run deletes anything, or a deletion isn't logged;
//  6. a planned name is tampered with between the plan and the call.
// Oracles: a literal account listing and literal PR states, and the literal deletions they must give; a fake
// Cloudflare client that records every call.
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { cleanupExitCode, cleanupResult, planCleanup, prStates, runCleanupDeletions } from './cleanup.mjs'
import { runTeardown } from './teardown.mjs'
import { ZONE, app } from './test-support.mjs'

const LISTING = {
  workers: ['live-site', 'live-product', 'inhouse-app', 'inhouse-app-preview', 'inhouse-sbx-product', 'inhouse-sbx-pr12', 'inhouse-sbx-pr13', 'inhouse-sbx-pr14', 'inhouse-sbx-pr15-x'],
  domains: [
    { id: 'dom-live', hostname: 'shop.example.test', service: 'live-product' },
    { id: 'dom-cand', hostname: `inhouse-sbx-brand.${ZONE}`, service: 'inhouse-sbx-product' },
    { id: 'dom-12b', hostname: `inhouse-sbx-pr12-brand.${ZONE}`, service: 'inhouse-sbx-pr12' },
    { id: 'dom-12t', hostname: `inhouse-sbx-pr12-team.${ZONE}`, service: 'inhouse-sbx-pr12' },
    { id: 'dom-12x', hostname: 'other.example.test', service: 'inhouse-sbx-pr12' },
    { id: 'dom-13b', hostname: `inhouse-sbx-pr13-brand.${ZONE}`, service: 'inhouse-sbx-pr13' },
  ],
  d1: [
    { name: 'live-product-db', uuid: 'u-live' }, { name: 'inhouse-sbx-db', uuid: 'u-cand' }, { name: 'inhouse-sbx-pr12-db', uuid: 'u-12' },
    { name: 'inhouse-sbx-pr13-db', uuid: 'u-13' }, { name: 'inhouse-sbx-pr15-db', uuid: 'u-15' },
  ],
  r2: ['live-product-files', 'inhouse-sbx-files', 'inhouse-sbx-pr12-files', 'inhouse-sbx-pr15-files', 'inhouse-sbx-pr15-other'],
  containers: [
    { id: 'c-live', name: 'live-product-runner' }, { id: 'c-cand', name: 'inhouse-sbx-product' }, { id: 'c-12', name: 'inhouse-sbx-pr12' },
    { id: 'c-13', name: 'inhouse-sbx-pr13' }, { id: 'c-15x', name: 'inhouse-sbx-pr15-runner' },
  ],
  images: [{ name: 'live-product', tags: ['v1'] }],
}
// PR 12 and 15 closed, 13 open, 14 unreadable (deleted, private, rate limited).
const STATES = new Map([[12, 'closed'], [13, 'open'], [14, 'unknown'], [15, 'closed']])

describe('planCleanup (failures 1 to 4)', () => {
  test('deletes exactly the closed PRs\' own names, in order, and reports the rest', () => {
    const plan = planCleanup(LISTING, STATES, { app, zone: ZONE })
    assert.deepEqual(plan.closed, [12, 15])
    assert.deepEqual(plan.kept, [{ pr: 13, state: 'open' }, { pr: 14, state: 'unknown' }])
    assert.deepEqual(plan.deletions, [
      { pr: 12, kind: 'domain', name: `inhouse-sbx-pr12-brand.${ZONE}`, id: 'dom-12b' },
      { pr: 12, kind: 'domain', name: `inhouse-sbx-pr12-team.${ZONE}`, id: 'dom-12t' },
      { pr: 12, kind: 'worker', name: 'inhouse-sbx-pr12' },
      { pr: 12, kind: 'container', name: 'inhouse-sbx-pr12', id: 'c-12' },
      { pr: 12, kind: 'd1', name: 'inhouse-sbx-pr12-db', id: 'u-12' },
      { pr: 12, kind: 'r2', name: 'inhouse-sbx-pr12-files' },
      { pr: 15, kind: 'd1', name: 'inhouse-sbx-pr15-db', id: 'u-15' },
      { pr: 15, kind: 'r2', name: 'inhouse-sbx-pr15-files' },
    ])
    assert.deepEqual(plan.skipped, [
      { name: 'other.example.test', why: 'a custom domain on inhouse-sbx-pr12 that isn\'t one of PR 12\'s hosts' },
      { name: 'inhouse-sbx-pr15-x', why: 'per-PR-shaped, but not a name this tool makes' },
      { name: 'inhouse-sbx-pr15-runner', why: 'per-PR-shaped, but not a name this tool makes' },
      { name: 'inhouse-sbx-pr15-other', why: 'per-PR-shaped, but not a name this tool makes' },
    ])
  })
  test('the run fails (exit 1) when any PR\'s state is unknown, and passes when every state was read', () => {
    assert.equal(cleanupExitCode(planCleanup(LISTING, STATES, { app, zone: ZONE })), 1)
    assert.equal(cleanupExitCode(planCleanup(LISTING, new Map([[12, 'closed'], [13, 'open'], [14, 'open'], [15, 'closed']]), { app, zone: ZONE })), 0)
  })
  test('the run\'s result: 1 for an unreadable state or a failed teardown, 0 otherwise (ops #2 round 4)', () => {
    const allRead = planCleanup(LISTING, new Map([[12, 'closed'], [13, 'open'], [14, 'open'], [15, 'closed']]), { app, zone: ZONE })
    assert.deepEqual(cleanupResult(allRead, []), { code: 0, lines: [] })
    assert.deepEqual(cleanupResult(allRead, [12]), { code: 1, lines: ['failing: the teardown of PR(s) [12] stopped part way (logged above); the other PRs were cleaned'] })
    assert.equal(cleanupResult(planCleanup(LISTING, STATES, { app, zone: ZONE }), []).code, 1)
  })
  test('a closed PR whose only leftover is its container application is still found and cleaned', () => {
    const only = { workers: [], domains: [], d1: [], r2: [], containers: [{ id: 'c-16', name: 'inhouse-sbx-pr16' }], images: [] }
    const plan = planCleanup(only, new Map([[16, 'closed']]), { app, zone: ZONE })
    assert.deepEqual(plan.closed, [16])
    assert.deepEqual(plan.deletions, [{ pr: 16, kind: 'container', name: 'inhouse-sbx-pr16', id: 'c-16' }])
  })
  test('a PR missing from the states counts as unknown and is kept', () => {
    const plan = planCleanup(LISTING, new Map([[12, 'closed']]), { app, zone: ZONE })
    assert.deepEqual(plan.closed, [12])
    assert.deepEqual(plan.kept.map(k => k.state), ['unknown', 'unknown', 'unknown'])
  })
})

/** A fake Cloudflare client: records calls; bucket objects listed from `objects`. */
function fakeCf(objects = {}) {
  const calls = []
  const rec = name => async (...a) => { calls.push([name, ...a]) }
  return {
    calls,
    async r2Keys(bucket) { calls.push(['r2Keys', bucket]); return objects[bucket] ?? [] },
    detachDomain: rec('detachDomain'), deleteWorker: rec('deleteWorker'), deleteD1: rec('deleteD1'), deleteContainerApp: rec('deleteContainerApp'),
    deleteR2Object: rec('deleteR2Object'), deleteR2: rec('deleteR2'), deleteImage: rec('deleteImage'),
  }
}

describe('runTeardown (failures 5, 6)', () => {
  const plan = planCleanup(LISTING, STATES, { app, zone: ZONE })
  test('makes exactly the planned calls, empties each bucket first and logs every deletion', async () => {
    const cf = fakeCf({ 'inhouse-sbx-pr12-files': ['photos/a.jpg', 'photos/b c.png'] })
    const log = []
    await runTeardown(cf, plan.deletions, { app, zone: ZONE, dryRun: false, log: l => log.push(l) })
    assert.deepEqual(cf.calls, [
      ['detachDomain', 'dom-12b'], ['detachDomain', 'dom-12t'], ['deleteWorker', 'inhouse-sbx-pr12'], ['deleteContainerApp', 'c-12'], ['deleteD1', 'u-12'],
      ['r2Keys', 'inhouse-sbx-pr12-files'], ['deleteR2Object', 'inhouse-sbx-pr12-files', 'photos/a.jpg'],
      ['deleteR2Object', 'inhouse-sbx-pr12-files', 'photos/b c.png'], ['deleteR2', 'inhouse-sbx-pr12-files'],
      ['deleteD1', 'u-15'], ['r2Keys', 'inhouse-sbx-pr15-files'], ['deleteR2', 'inhouse-sbx-pr15-files'],
    ])
    assert.equal(log.filter(l => l.startsWith('deleted ')).length, plan.deletions.length)
    assert.ok(log.includes('emptied inhouse-sbx-pr12-files (2 of 2 objects)'))
  })
  test('an unsafe key is left in the bucket and logged; the bucket delete is still tried (and fails loudly for real)', async () => {
    const cf = fakeCf({ 'inhouse-sbx-pr12-files': ['photos/a.jpg', '../../../../workers/scripts/live-product', 'a//b', './x'] })
    const log = []
    await runTeardown(cf, [{ pr: 12, kind: 'r2', name: 'inhouse-sbx-pr12-files' }], { app, zone: ZONE, dryRun: false, log: l => log.push(l) })
    assert.deepEqual(cf.calls.filter(c => c[0] === 'deleteR2Object'), [['deleteR2Object', 'inhouse-sbx-pr12-files', 'photos/a.jpg']])
    assert.ok(log.includes('emptied inhouse-sbx-pr12-files (1 of 4 objects)'))
    assert.equal(log.filter(l => l.startsWith('left in inhouse-sbx-pr12-files')).length, 3)
    assert.deepEqual(cf.calls.at(-1), ['deleteR2', 'inhouse-sbx-pr12-files'])
  })
  test('one PR\'s failed teardown is logged and the next PRs are still cleaned (ops #1 round 3, L2)', async () => {
    const cf = fakeCf({ 'inhouse-sbx-pr12-files': ['../escape'] })
    cf.deleteR2 = async b => { cf.calls.push(['deleteR2', b]); if (b === 'inhouse-sbx-pr12-files') throw new Error('bucket not empty') }
    const log = []
    const failed = await runCleanupDeletions(cf, plan.deletions, { app, zone: ZONE, dryRun: false, log: l => log.push(l) })
    assert.deepEqual(failed, [12])
    assert.ok(log.includes('PR 12: teardown failed: bucket not empty'))
    // PR 15's deletions all ran after PR 12 failed.
    assert.deepEqual(cf.calls.slice(-3), [['deleteD1', 'u-15'], ['r2Keys', 'inhouse-sbx-pr15-files'], ['deleteR2', 'inhouse-sbx-pr15-files']])
  })
  test('a dry run calls nothing and logs the plan', async () => {
    const cf = fakeCf()
    const log = []
    await runTeardown(cf, plan.deletions, { app, zone: ZONE, dryRun: true, log: l => log.push(l) })
    assert.deepEqual(cf.calls, [])
    assert.equal(log.filter(l => l.startsWith('would delete ')).length, plan.deletions.length)
  })
  test('a tampered deletion is refused before any call', async () => {
    for (const bad of [
      { pr: 12, kind: 'worker', name: 'live-product' },
      { pr: 12, kind: 'd1', name: 'inhouse-sbx-db', id: 'u-cand' },
      { pr: 12, kind: 'r2', name: 'inhouse-sbx-pr13-files' },
      { pr: 12, kind: 'domain', name: 'shop.example.test', id: 'dom-live' },
      { pr: 12, kind: 'unknown', name: 'inhouse-sbx-pr12' },
      { pr: 12, kind: 'container', name: 'inhouse-sbx-product', id: 'c-cand' },
      { pr: 12, kind: 'container', name: 'inhouse-sbx-pr13', id: 'c-13' },
      { pr: 12, kind: 'image', name: 'inhouse-sbx-pr13', tag: 'x' },
      { pr: 12, kind: 'image', name: 'live-product', tag: 'v1' },
    ]) {
      const cf = fakeCf()
      await assert.rejects(runTeardown(cf, [bad], { app, zone: ZONE, dryRun: false, log: () => {} }), /refusing to delete/)
      assert.deepEqual(cf.calls, [])
    }
  })
})

describe('prStates', () => {
  test('open and closed from the API, anything else unknown', async () => {
    const answers = { 12: [200, { state: 'closed' }], 13: [200, { state: 'open' }], 14: [404, { message: 'Not Found' }], 15: [200, { state: 'weird' }] }
    const seen = []
    const fetchImpl = async (url, init) => {
      seen.push([url, init.headers.authorization ?? null])
      const [status, body] = answers[Number(url.split('/').at(-1))]
      return { ok: status === 200, json: async () => body }
    }
    const states = await prStates([12, 13, 14, 15], { token: undefined, fetchImpl })
    assert.deepEqual([...states], [[12, 'closed'], [13, 'open'], [14, 'unknown'], [15, 'unknown']])
    assert.deepEqual(seen.map(s => s[0]), [12, 13, 14, 15].map(n => `https://api.github.com/repos/Useful-Build/inhouse/pulls/${n}`))
    assert.ok(seen.every(s => s[1] === null))
  })
})

// The runner images a PR's deploys pushed (inhouse-sbx-pr<N>:<sha>) are torn down with the rest. Ways it could fail:
// another PR's or a live product's image goes, a closed PR whose only leftover is an image is never found, the tag a
// deploy just pushed is deleted before the deploy uses it.
describe('runner images', () => {
  const listing = {
    workers: [], domains: [], d1: [], r2: [], containers: [],
    images: [{ name: 'live-product', tags: ['v1'] }, { name: 'inhouse-sbx-product', tags: ['cand'] }, { name: 'inhouse-sbx-pr12', tags: ['aaa', 'bbb'] }, { name: 'inhouse-sbx-pr13', tags: ['ccc'] }, { name: 'inhouse-sbx-pr12-other', tags: ['x'] }],
  }
  test('a closed PR\'s tags go, found from the image alone; other PRs\' and live images stay', () => {
    const plan = planCleanup(listing, new Map([[12, 'closed'], [13, 'open']]), { app, zone: ZONE })
    assert.deepEqual(plan.closed, [12])
    assert.deepEqual(plan.deletions, [{ pr: 12, kind: 'image', name: 'inhouse-sbx-pr12', tag: 'aaa' }, { pr: 12, kind: 'image', name: 'inhouse-sbx-pr12', tag: 'bbb' }])
    assert.ok(plan.skipped.some(s => s.name === 'inhouse-sbx-pr12-other'))
  })
  test('keepImageTags keeps the tag a deploy just pushed', async () => {
    const { planTeardown } = await import('./teardown.mjs')
    const { deletions } = planTeardown(listing, [12], { app, zone: ZONE, keepImageTags: ['bbb'] })
    assert.deepEqual(deletions, [{ pr: 12, kind: 'image', name: 'inhouse-sbx-pr12', tag: 'aaa' }])
  })
  test('runTeardown deletes each tag by name and tag', async () => {
    const cf = fakeCf()
    const plan = planCleanup(listing, new Map([[12, 'closed'], [13, 'open']]), { app, zone: ZONE })
    await runTeardown(cf, plan.deletions, { app, zone: ZONE, dryRun: false, log: () => {} })
    assert.deepEqual(cf.calls, [['deleteImage', 'inhouse-sbx-pr12', 'aaa'], ['deleteImage', 'inhouse-sbx-pr12', 'bbb']])
  })
})
