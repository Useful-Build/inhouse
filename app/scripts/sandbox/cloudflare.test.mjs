// scripts/lib/cloudflare.mjs at the URL level. Ways it could fail, written down first:
//  1. an R2 key with slashes is sent with %2F (the docs: slashes MUST be literal), so a photo's delete misses it, or a
//     reserved character in a segment isn't encoded;
//  2. a listing stops after the first page, or never stops (a last page whose cursor the docs don't describe);
//  3. the token leaks into a URL or an error message;
//  4. a name or key with '.' or '..' segments (a PR's code writes R2 keys) climbs out of its path: new URL() resolves
//     them, so a teardown could send an account-level DELETE with the sandbox token.
// Oracle: a fake fetch that records every request and answers from literal pages.
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { cloudflare } from './cloudflare.mjs'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const TOKEN = 'token-value-for-the-test'
/** A fetch that records [method, url, auth] and answers with `answer(url)` (an object: the JSON body). */
function fakeFetch(answer) {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push([init.method, String(url), init.headers.authorization])
    const body = answer(new URL(url))
    return { ok: body.success !== false, status: body.success === false ? 403 : 200, json: async () => body }
  }
  return { seen, fetchImpl }
}
const base = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`

describe('R2 object keys (failure 1)', () => {
  test('a path-like key keeps its slashes; each segment is percent-encoded', async () => {
    const f = fakeFetch(() => ({ success: true, result: null }))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    await cf.deleteR2Object('inhouse-sbx-pr12-files', 'photos/m_AbC-123/r4nd0m')
    await cf.deleteR2Object('inhouse-sbx-pr12-files', 'photos/a b/x?y#z%')
    assert.deepEqual(f.seen.map(s => s.slice(0, 2)), [
      ['DELETE', `${base}/r2/buckets/inhouse-sbx-pr12-files/objects/photos/m_AbC-123/r4nd0m`],
      ['DELETE', `${base}/r2/buckets/inhouse-sbx-pr12-files/objects/photos/a%20b/x%3Fy%23z%25`],
    ])
    assert.ok(f.seen.every(s => s[2] === `Bearer ${TOKEN}` && !s[1].includes(TOKEN)))
  })
})

describe('nothing reaches fetch on a path that resolves elsewhere (failure 4)', () => {
  const bad = ['..', '../x', 'a/../../b', './a', 'a//b', '/a', 'a/', '', '../../../../workers/scripts/live-product']
  for (const key of bad) {
    test(`R2 key ${JSON.stringify(key)}`, async () => {
      const f = fakeFetch(() => ({ success: true, result: null }))
      const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
      await assert.rejects(cf.deleteR2Object('inhouse-sbx-pr12-files', key), /refusing/)
      assert.deepEqual(f.seen, [])
    })
  }
  test('any call whose name resolves to another path, the key check aside', async () => {
    const f = fakeFetch(() => ({ success: true, result: null }))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    for (const call of [() => cf.deleteR2('..'), () => cf.deleteR2('.'), () => cf.deleteWorker('..'), () => cf.deleteD1('..'), () => cf.detachDomain('.'), () => cf.r2Keys('..')]) {
      await assert.rejects(call(), /the URL resolves elsewhere/)
    }
    assert.deepEqual(f.seen, [])
  })
})

describe('container applications', () => {
  test('lists { id, name } and deletes by id on exactly its path; an id that climbs out never reaches fetch', async () => {
    const f = fakeFetch(url => (url.pathname.endsWith('/containers/applications')
      ? { success: true, result: [{ id: 'a032c2b3', name: 'inhouse-sbx-pr159', configuration: {} }] }
      : { success: true, result: null }))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    assert.deepEqual(await cf.containerApps(), [{ id: 'a032c2b3', name: 'inhouse-sbx-pr159' }])
    await cf.deleteContainerApp('a032c2b3')
    await assert.rejects(cf.deleteContainerApp('..'), /the URL resolves elsewhere/)
    assert.deepEqual(f.seen.map(s => s.slice(0, 2)), [
      ['GET', `${base}/containers/applications`],
      ['DELETE', `${base}/containers/applications/a032c2b3`],
    ])
  })
})

describe('paging (failure 2)', () => {
  test('objects: follows the cursor while is_truncated, and stops when it isn\'t', async () => {
    const pages = { '': { keys: ['a', 'b'], next: 'c1', truncated: true }, c1: { keys: ['c'], next: 'c2', truncated: true }, c2: { keys: ['d'], next: 'c3', truncated: false } }
    const f = fakeFetch(url => {
      const p = pages[url.searchParams.get('cursor') ?? '']
      return { success: true, result: p.keys.map(key => ({ key })), result_info: { cursor: p.next, is_truncated: p.truncated, per_page: 1000 } }
    })
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    assert.deepEqual(await cf.r2Keys('b'), ['a', 'b', 'c', 'd'])
    assert.equal(f.seen.length, 3)
  })
  test('buckets: follows the cursor over full pages; stops on a short page, no cursor, or a repeated cursor', async () => {
    const full = n => Array.from({ length: 1000 }, (_, i) => ({ name: `b${n}-${i}` }))
    for (const [last, calls] of [[{ buckets: [{ name: 'z' }], cursor: 'again' }, 3], [{ buckets: full(3), cursor: undefined }, 3], [{ buckets: full(3), cursor: 'c1' }, 3]]) {
      const pages = { '': { buckets: full(1), cursor: 'c1' }, c1: { buckets: full(2), cursor: 'c2' }, c2: last }
      const f = fakeFetch(url => {
        const p = pages[url.searchParams.get('cursor') ?? '']
        return { success: true, result: { buckets: p.buckets }, result_info: { cursor: p.cursor } }
      })
      const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
      const names = await cf.r2()
      assert.equal(f.seen.length, calls)
      assert.equal(names.length, 2000 + last.buckets.length)
    }
  })
  test('D1: pages until a short page', async () => {
    const f = fakeFetch(url => {
      const page = Number(url.searchParams.get('page'))
      const n = page === 1 ? 100 : 7
      return { success: true, result: Array.from({ length: n }, (_, i) => ({ name: `d${page}-${i}`, uuid: `u${page}-${i}` })) }
    })
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    assert.equal((await cf.d1()).length, 107)
    assert.equal(f.seen.length, 2)
  })
})

describe('errors (failure 3)', () => {
  test('a refused call throws with the path and the API\'s errors, never the token', async () => {
    const f = fakeFetch(() => ({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    await assert.rejects(cf.deleteWorker('inhouse-sbx-pr12'), err => {
      assert.match(err.message, /DELETE \/workers\/scripts\/inhouse-sbx-pr12 answered 403 \(10000: Authentication error\)/)
      assert.ok(!err.message.includes(TOKEN))
      return true
    })
  })
})

describe('createR2 after a delete (10073: same-name recreation blocked)', () => {
  const DELETED_AT = Date.parse('2026-11-24T03:17:04.181Z')
  const message = until => `Bucket was deleted at 2026-11-24T03:17:04.181Z; same-name recreation is blocked until ${until}`
  /** A client whose POST answers from `answers` in turn; the clock and sleep are fake, so no test waits. */
  function setup(answers) {
    const posts = []
    const sleeps = []
    const logs = []
    let clock = DELETED_AT + 1000
    const fetchImpl = async (url, init) => {
      posts.push([init.method, String(url)])
      const a = answers.shift()
      return { ok: a.status < 300, status: a.status, json: async () => a.body }
    }
    const cf = cloudflare({
      token: TOKEN, accountId: ACCOUNT, fetchImpl, now: () => clock, log: m => logs.push(m),
      sleep: async ms => { sleeps.push(ms); clock += ms },
    })
    return { cf, posts, sleeps, logs }
  }
  const conflict = (code, msg) => ({ status: 409, body: { success: false, errors: [{ code, message: msg }] } })
  const created = { status: 200, body: { success: true, result: {} } }

  test('waits until the stated time (60 s out), retries once and succeeds, with a warning', async () => {
    const s = setup([conflict(10073, message('2026-11-24T03:18:04.181Z')), created])
    await s.cf.createR2('inhouse-sbx-pr380-files')
    assert.equal(s.posts.length, 2)
    assert.deepEqual(s.sleeps, [59_000 + 2_000]) // 60 s out, 1 s already passed, plus the 2 s margin
    assert.equal(s.logs.length, 1)
    assert.match(s.logs[0], /^::warning::.*inhouse-sbx-pr380-files/)
  })
  test('a second 10073 after the retry throws (one retry only)', async () => {
    const s = setup([conflict(10073, message('2026-11-24T03:18:04.181Z')), conflict(10073, message('2026-11-24T03:19:04.181Z'))])
    await assert.rejects(() => s.cf.createR2('b'), /10073/)
    assert.equal(s.posts.length, 2)
  })
  test('a time beyond the 120 s cap fails loud and never waits', async () => {
    const s = setup([conflict(10073, message('2026-11-24T03:25:04.181Z'))])
    await assert.rejects(() => s.cf.createR2('b'), /over the 120 s cap/)
    assert.equal(s.posts.length, 1)
    assert.deepEqual(s.sleeps, [])
  })
  test('an unparseable message fails loud and never waits', async () => {
    const s = setup([conflict(10073, 'Bucket was deleted recently; try again later')])
    await assert.rejects(() => s.cf.createR2('b'), /no readable "blocked until" time/)
    assert.equal(s.posts.length, 1)
    assert.deepEqual(s.sleeps, [])
  })
  test('any other 409 is unchanged: thrown at once, no retry', async () => {
    const s = setup([conflict(10004, 'The bucket you tried to create already exists')])
    await assert.rejects(() => s.cf.createR2('b'), /answered 409 \(10004: The bucket you tried to create already exists\)/)
    assert.equal(s.posts.length, 1)
    assert.deepEqual(s.sleeps, [])
  })
  test('a success on the first try never sleeps or warns', async () => {
    const s = setup([created])
    await s.cf.createR2('b')
    assert.deepEqual([s.sleeps, s.logs], [[], []])
  })
})

describe('custom domains', () => {
  test('a second page fails loud rather than hiding a domain a teardown would skip', async () => {
    const f = fakeFetch(() => ({ success: true, result: [{ id: 'd1', hostname: 'h', service: 's' }], result_info: { total_pages: 2 } }))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: f.fetchImpl })
    await assert.rejects(cf.domains(), /more than one page/)
  })
})

// The registry, as wrangler 4.162 reaches it. Ways it could fail: the registry password reaches a URL or an error; a
// name or tag that isn't plain builds another path; another account's repository is listed as ours; an image that is
// already gone stops a teardown.
describe('runner images in the registry', () => {
  /** Answers the credentials call, then registry calls by method and path. */
  function registry(answers) {
    const seen = []
    const fetchImpl = async (url, init) => {
      const u = new URL(url)
      seen.push([init.method, String(url), init.headers.authorization])
      if (u.host === 'api.cloudflare.com') return { ok: true, status: 200, json: async () => ({ success: true, result: { password: 'registry-secret' } }) }
      const [status, body] = answers(init.method, u.pathname) ?? [200, {}]
      return { ok: status < 300, status, json: async () => body }
    }
    return { seen, fetchImpl }
  }
  const basic = `Basic ${Buffer.from('v1:registry-secret').toString('base64')}`
  // wrangler 4.162's own fixture shape (cloudchamber images tests): each repository lists its tags and a digest entry.
  test('drops the catalog\'s sha256 digest entries, as wrangler does; an unexpected answer fails loud', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    const r = registry(() => [200, { repositories: { [`${ACCOUNT}/inhouse-sbx-pr12`]: ['0123abc', digest], [`${ACCOUNT}/inhouse-sbx-pr13`]: [digest] } }])
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: r.fetchImpl })
    assert.deepEqual(await cf.images(), [{ name: 'inhouse-sbx-pr12', tags: ['0123abc'] }, { name: 'inhouse-sbx-pr13', tags: [] }])
    for (const body of [{}, { repositories: [] }, { repositories: { [`${ACCOUNT}/x`]: 'tag' } }]) {
      const bad = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: registry(() => [200, body]).fetchImpl })
      await assert.rejects(bad.images(), /registry catalog/)
    }
  })
  test('lists this account\'s repositories with their tags, the prefix dropped', async () => {
    const r = registry(() => [200, { repositories: { [`${ACCOUNT}/inhouse-sbx-pr12`]: ['aaa'], [`/${ACCOUNT}/inhouse-sbx-pr13`]: ['b'], 'ffffffffffffffffffffffffffffffff/other': ['c'] } }])
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: r.fetchImpl })
    assert.deepEqual(await cf.images(), [{ name: 'inhouse-sbx-pr12', tags: ['aaa'] }, { name: 'inhouse-sbx-pr13', tags: ['b'] }])
    assert.deepEqual(r.seen.map(s => s.slice(0, 2)), [
      ['POST', `${base}/containers/registries/registry.cloudflare.com/credentials`],
      ['GET', 'https://registry.cloudflare.com/v2/_catalog?tags=true'],
    ])
    assert.equal(r.seen[1][2], basic)
  })
  test('deletes a tag: HEAD, DELETE the manifest, then collect layers; a tag already gone is skipped', async () => {
    const r = registry((method, path) => (path.endsWith('/gone') && method === 'HEAD' ? [404, {}] : [200, {}]))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: r.fetchImpl })
    assert.deepEqual(await cf.deleteImage('inhouse-sbx-pr12', 'aaa'), { deleted: true })
    assert.deepEqual(await cf.deleteImage('inhouse-sbx-pr12', 'gone'), { deleted: false })
    const m = `https://registry.cloudflare.com/v2/${ACCOUNT}/inhouse-sbx-pr12/manifests`
    assert.deepEqual(r.seen.filter(s => new URL(s[1]).host === 'registry.cloudflare.com').map(s => s.slice(0, 2)), [
      ['HEAD', `${m}/aaa`], ['DELETE', `${m}/aaa`], ['PUT', 'https://registry.cloudflare.com/v2/gc/layers'], ['HEAD', `${m}/gone`],
    ])
  })
  test('refuses a name or tag that isn\'t plain, before any call; a failed delete names no password', async () => {
    const r = registry(method => (method === 'DELETE' ? [500, {}] : [200, {}]))
    const cf = cloudflare({ token: TOKEN, accountId: ACCOUNT, fetchImpl: r.fetchImpl })
    for (const [name, tag] of [['../x', 'a'], ['inhouse-sbx-pr12', '../a'], ['inhouse-sbx-pr12', ''], ['Upper', 'a'], ['inhouse-sbx-pr12', 'a/b']]) {
      await assert.rejects(cf.deleteImage(name, tag), /not a plain name and tag/)
    }
    assert.deepEqual(r.seen, [])
    await assert.rejects(cf.deleteImage('inhouse-sbx-pr12', 'aaa'), err => !String(err.message).includes('registry-secret') && /answered 500/.test(err.message))
  })
})
