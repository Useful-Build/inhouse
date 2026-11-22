// The deployment-facing pieces' refusals: the R2 reader's bucket, key and token rules, the row reader's shapes, the effort pin
// and its put-back, which cases the product target serves now, and the proof mode's guards.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DoorRefusal, type RunSql } from '../../targets/door.ts'
import { liveOnProduct, parseReadSideArgs } from '../args.ts'
import { P5, PAGE, READ_SIDE_CASES, TEAM } from '../cases.ts'
import { main } from '../cli.ts'
import { defaultLabel, effortKey, pinEffort, type SettingsApi } from './effort.ts'
import { createSessionReader } from './r2.ts'
import { createRowReader } from './rows.ts'
import { renderPage } from '../pages.ts'
import { READ_SIDE_ENV, wireEval, wireProof, type Wired } from './setup.ts'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const env = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'tok-secret-1' }
const CHAT = 'eval-0123456789abcdef01234567'
const KEY = `sessions/${CHAT}/0f8fad5b-d9cb-469f-a165-70867728950e/${'a'.repeat(64)}/m/000001763800000-000001.json`
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('the R2 session reader', () => {
  it('refuses any bucket but the eval one, and in the proof only that PR\'s', () => {
    expect(() => createSessionReader({ env, bucket: 'inhouse-sbx-pr7-files' })).toThrow(DoorRefusal)
    expect(() => createSessionReader({ env, bucket: 'inhouse-sbx-eval-files', proofPr: 7 })).toThrow(/this PR/)
    expect(() => createSessionReader({ env, bucket: 'inhouse-sbx-pr8-files', proofPr: 7 })).toThrow(DoorRefusal)
    expect(() => createSessionReader({ env, bucket: 'inhouse-sbx-pr7-files', proofPr: 7 })).not.toThrow()
    expect(() => createSessionReader({ env: { ...env, CLOUDFLARE_API_TOKEN: '' }, bucket: 'inhouse-sbx-eval-files' })).toThrow(/CLOUDFLARE_API_TOKEN/)
  })
  it('reads every part of the chat, and refuses a foreign key, a redirect, a non-eval chat id and a token in an error', async () => {
    const calls: string[] = []
    const ok = createSessionReader({ env, bucket: 'inhouse-sbx-eval-files', fetch: (async (u: string | URL) => {
      calls.push(String(u))
      return String(u).includes('?') ? json(200, { success: true, result: [{ key: KEY, size: 4 }], result_info: { is_truncated: false } }) : new Response('[{}]')
    }) as typeof fetch })
    expect((await ok.parts(CHAT)).map((p) => new TextDecoder().decode(p))).toEqual(['[{}]'])
    expect(calls[0]).toContain('/r2/buckets/inhouse-sbx-eval-files/objects?prefix=sessions%2Feval-')
    await expect(ok.parts('rc_abc')).rejects.toThrow(/not an eval chat id/)
    const foreign = createSessionReader({ env, bucket: 'inhouse-sbx-eval-files', fetch: (async () => json(200, { success: true, result: [{ key: `sessions/${CHAT}/x.json`, size: 1 }] })) as unknown as typeof fetch })
    await expect(foreign.parts(CHAT)).rejects.toThrow(/not a transcript key/)
    const redirect = createSessionReader({ env, bucket: 'inhouse-sbx-eval-files', fetch: (async () => new Response('', { status: 302 })) as unknown as typeof fetch })
    await expect(redirect.preflight()).rejects.toThrow(/302/)
    const leaky = createSessionReader({ env, bucket: 'inhouse-sbx-eval-files', fetch: (async () => { throw new Error('bad tok-secret-1') }) as unknown as typeof fetch })
    await expect(leaky.preflight()).rejects.toThrow(/\[secret\]/)
  })
})

describe('the row reader', () => {
  it('builds read-only statements and refuses a value of the wrong shape', async () => {
    const seen: string[] = []
    const run: RunSql = async (sql) => {
      seen.push(sql)
      if (sql.startsWith('SELECT text FROM memories')) return [{ text: 'a' }]
      if (sql.includes('FROM routines')) return [{ id: 'r', rev: 1, name: 'n', instruction: 'i', deleted_at_ms: null }]
      if (sql.includes('FROM notices')) return [{ template: 't', fields_json: '{}', body: null }]
      if (sql.includes('team_requests')) return [{ id: 'q', text: 'please', n: 3 }]
      return []
    }
    const rows = createRowReader(run, { teamRequestsTable: true })
    expect(await rows.memoryTexts()).toEqual(['a'])
    expect(await rows.routines(5)).toEqual([{ id: 'r', rev: 1, text: 'n\ni', live: true }])
    expect(await rows.noticeTexts(5)).toEqual(['t\n{}\n'])
    expect(await rows.teamRequestTexts(5)).toEqual(['q\nplease'])
    expect(seen.every((s) => s.startsWith('SELECT'))).toBe(true)
    await expect(rows.noticeTexts(-1)).rejects.toThrow(DoorRefusal)
    expect(await createRowReader(run, { teamRequestsTable: false }).teamRequestTexts(5)).toBeNull()
    await expect(createRowReader(async () => [{ text: 3 }], { teamRequestsTable: false }).memoryTexts()).rejects.toThrow(DoorRefusal)
  })
})

describe('the effort pin', () => {
  function settings(start: unknown, o: { putStatus?: number; sticks?: boolean } = {}) {
    let key = ''
    let value = start
    let rev = 3
    const log: string[] = []
    const api: SettingsApi = {
      admin: async (method, path, body) => {
        log.push(`admin ${method} ${path}`)
        if (path === '/api/settings/technical') return { status: 200, json: { items: value === undefined ? [] : [{ key, value, rev }] } }
        if (path === '/api/grants' && method === 'GET') return { status: 200, json: { items: [{ id: 'g1', rev: 1, live: true }] } }
        if (path === '/api/grants') return { status: 201, json: {} }
        return { status: 200, json: body ?? {} }
      },
      inhouse: async (method, path, body) => {
        log.push(`inhouse ${method} ${path} ${JSON.stringify(body)}`)
        if (o.sticks !== false) { value = (body as { value: unknown }).value; key = decodeURIComponent(path.split('/').pop()!); rev++ }
        return { status: o.putStatus ?? 200, json: {} }
      },
    }
    return { api, log, now: () => value, setKey: (k: string) => { key = k } }
  }
  it('writes Medium as the Inhouse team under a grant, reads it back, and puts the old value back', async () => {
    const s = settings('High')
    s.setKey('tm:opus:effort')
    const restore = await pinEffort(s.api, 'claude-opus-5-5')
    expect(s.now()).toBe('Medium')
    expect(s.log).toContain('inhouse PUT /api/settings/technical/tm%3Aopus%3Aeffort {"value":"Medium","ifRev":3}')
    expect(s.log.filter((l) => l.startsWith('admin POST /api/grants/g1/end')).length).toBe(2)
    await restore()
    expect(s.now()).toBe('High')
  })
  it('puts a key that was never set back to the catalogue default, and refuses a value that doesn\'t read back', async () => {
    const s = settings(undefined)
    await (await pinEffort(s.api, 'claude-haiku-5-5'))()
    expect(s.now()).toBe(defaultLabel('claude-haiku-5-5'))
    expect(defaultLabel('claude-haiku-5-5')).toBe('Low')
    expect(effortKey('claude-fable-5-2')).toBe('tm:fable:effort')
    const stuck = settings('High', { sticks: false })
    stuck.setKey('tm:opus:effort')
    await expect(pinEffort(stuck.api, 'claude-opus-5-5')).rejects.toThrow(/reads back/)
    await expect(pinEffort(settings('High', { putStatus: 403 }).api, 'claude-opus-5-5')).rejects.toThrow(/403/)
  })
})

describe('what the product target serves now', () => {
  it('lifts the page blocker with a page origin and the P5 blocker on notice exits outside Slack; keeps Slack and team requests', () => {
    const live = liveOnProduct(READ_SIDE_CASES, 'https://pages.example.test')
    const of = (id: string) => live.find((c) => c.id === id)!
    expect(of('RS-WW1').pending).toBeUndefined()
    expect(of('RS-TN1').pending).toBeUndefined()
    expect(of('RS-WN2').pending).toBeUndefined()
    expect(of('RS-LW1').pending).toBe(P5)
    expect(of('RS-TT1').pending).toBe(TEAM)
    expect(of('RS-WT1').pending).toBe(TEAM)
    expect(liveOnProduct(READ_SIDE_CASES, null).find((c) => c.id === 'RS-WW1')!.pending).toBe(PAGE)
    const product = parseReadSideArgs({ target: 'product', model: 'claude-sonnet-5-5', out: '/tmp/x', paid: true, budget: '50', 'page-origin': 'https://pages.example.test' })
    expect(product.cases.filter((c) => c.pending === undefined).map((c) => c.id)).toEqual(['RS-SF1', 'RS-SF2', 'RS-TN1', 'RS-TN2', 'RS-TF1', 'RS-TF2', 'RS-TM1', 'RS-TM2', 'RS-TR1', 'RS-TR2', 'RS-WW1', 'RS-WW2', 'RS-WM1', 'RS-WM2', 'RS-WN1', 'RS-WN2', 'RS-WF1', 'RS-WF2', 'RS-WR1', 'RS-WR2'])
    // The fake still serves every case.
    expect(parseReadSideArgs({ target: 'fake', out: '/tmp/x' }).cases.filter((c) => c.pending !== undefined).length).toBeGreaterThan(0)
  })
})

describe('the wiring', () => {
  it('names every env variable the paid run reads (A10\'s gate lists them)', () => {
    expect(READ_SIDE_ENV).toEqual(['INHOUSE_EVAL_BRAND', 'INHOUSE_EVAL_ORIGIN', 'INHOUSE_EVAL_ISSUER_JWK_FILE', 'INHOUSE_EVAL_AUD', 'INHOUSE_EVAL_ACCESS_CLIENT_ID', 'INHOUSE_EVAL_ACCESS_CLIENT_SECRET', 'INHOUSE_EVAL_D1_NAME', 'INHOUSE_EVAL_WRANGLER_CONFIG', 'INHOUSE_EVAL_INHOUSE_ORIGIN', 'INHOUSE_EVAL_INHOUSE_AUD', 'CF_SANDBOX_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'INHOUSE_EVAL_RUN', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'])
  })
  it('the proof refuses the eval database, another PR\'s, and the eval build', async () => {
    const raw = { current: async () => ({ status: 200, bytes: new Uint8Array(), json: { evalBrand: true, memberId: 'm_x' } }), admin: async () => ({ status: 200, bytes: new Uint8Array(), json: {} }) }
    const base = { pr: 7, api: (async () => ({ status: 200, json: {}, text: '' })) as never, raw, scenarioOf: () => 'x', note: () => {} }
    await expect(wireProof({ ...base, env: { ...env, INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-eval-db' } })).rejects.toThrow(/PR 7's test database/)
    await expect(wireProof({ ...base, env: { ...env, INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-pr8-db' } })).rejects.toThrow(/PR 7's test database/)
  })
  it('the command line registers its stop handlers before the wiring, which refuses with exit 2 and no results directory', async () => {
    const errs: string[] = []
    const order: string[] = []
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'rs-cli-')), 'out')
    const code = await main(['--target', 'product', '--model', 'claude-sonnet-5-5', '--out', out, '--paid', '--budget', '50', '--page-origin', 'https://pages.example.test'], {
      git: (a) => (a[0] === 'rev-parse' ? 'abc1234' : ''), log: () => {}, err: (m) => errs.push(m), env: {},
      wire: async () => { order.push('wire'); throw new Error('read-side: refusing: preflight failed') },
      onSignals: () => { order.push('signals') },
    })
    expect(code).toBe(2)
    expect(order).toEqual(['signals', 'wire'])
    expect(errs.join('\n')).toContain('preflight failed')
    expect(existsSync(out)).toBe(false)
  })
})

/** A Wired whose close counts its runs and can be held open, for the command line's stop paths. */
function fakeWired(o: { leftovers?: string[]; hold?: Promise<void> } = {}) {
  let runs = 0
  let closing: Promise<string[]> | null = null
  const wired: Wired = {
    teamRequests: 'rows',
    target: { name: 'product', honorsPending: true, async run() { throw new Error('not in this test') }, async stop() { return [] } },
    close: () => (closing ??= (async () => { runs++; await o.hold; return o.leftovers ?? [] })()),
  }
  return { wired, runs: () => runs }
}
const cliArgs = (out: string) => ['--target', 'product', '--model', 'claude-sonnet-5-5', '--out', out, '--paid', '--budget', '50', '--page-origin', 'https://pages.example.test', '--cases', 'RS-LW1']
const cliDeps = (errs: string[]) => ({ git: (a: string[]) => (a[0] === 'rev-parse' ? 'abc1234' : ''), log: () => {}, err: (m: string) => errs.push(m), env: {} })

describe('the command line\'s stop paths', () => {
  it('a results directory it can\'t make still closes the wiring (lease and effort given back), exit 2', async () => {
    const f = fakeWired()
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'rs-cli-')), 'a-file')
    writeFileSync(file, 'x')
    const errs: string[] = []
    expect(await main(cliArgs(path.join(file, 'sub')), { ...cliDeps(errs), wire: async () => f.wired, onSignals: () => {} })).toBe(2)
    expect(f.runs()).toBe(1)
  })
  it('anything not given back at the end makes the exit 2 and is in the report', async () => {
    const f = fakeWired({ leftovers: ['the effort could not be put back: 403'] })
    const out = mkdtempSync(path.join(tmpdir(), 'rs-cli-'))
    const errs: string[] = []
    expect(await main(cliArgs(out), { ...cliDeps(errs), wire: async () => f.wired, onSignals: () => {} })).toBe(2)
    const [dir] = readdirSync(out)
    const report = JSON.parse(readFileSync(path.join(out, dir!, 'report.json'), 'utf8'))
    expect(report.meta.leftovers).toEqual(['the effort could not be put back: 403'])
    expect(report.exitCode).toBe(2)
    expect(readFileSync(path.join(out, dir!, 'report.md'), 'utf8')).toContain('Not given back at the end')
  })
  it('a signal during the final close awaits the same close: the work runs once and the stop returns only when it is done', async () => {
    let release!: () => void
    const f = fakeWired({ hold: new Promise<void>((r) => { release = r }) })
    let stop!: () => Promise<void>
    const out = mkdtempSync(path.join(tmpdir(), 'rs-cli-'))
    const errs: string[] = []
    const running = main(cliArgs(out), { ...cliDeps(errs), wire: async () => f.wired, onSignals: (s) => { stop = s } })
    // The run has no live case to run (RS-LW1 waits on P5), so it is straight into the final close, held open here.
    await new Promise<void>((r) => setImmediate(r))
    let stopped = false
    const signal = stop().then(() => { stopped = true })
    await new Promise<void>((r) => setImmediate(r))
    expect(stopped).toBe(false)
    release()
    await signal
    expect(await running).toBe(1)
    expect(f.runs()).toBe(1)
  })
  it('a signal during the wiring closes what the wiring registered so far', async () => {
    const f = fakeWired()
    let stop!: () => Promise<void>
    const errs: string[] = []
    const code = await main(cliArgs(mkdtempSync(path.join(tmpdir(), 'rs-cli-'))), {
      ...cliDeps(errs), onSignals: (s) => { stop = s },
      wire: async (o) => { o.register?.(f.wired.close); await stop(); throw new Error('stopped by the signal') },
    })
    expect(code).toBe(2)
    expect(f.runs()).toBe(1)
  })
})

/** A fake eval deployment for wireEval: its database, its HTTP and its bucket, each step able to refuse. */
function fakeEval(failAt: string | null) {
  const sql: string[] = []
  const http: string[] = []
  let leaseHeld = false
  let effort: string | undefined = 'High'
  let effortRev = 2
  const grants = new Map<string, boolean>()
  const run: RunSql = async (q) => {
    sql.push(q)
    if (q.includes('sqlite_master')) {
      const name = /name = '([a-z_]+)'/.exec(q)?.[1]
      if (failAt === 'tables' && name === 'notices') return []
      return name === 'team_requests' ? [] : [{ name }]
    }
    if (q.endsWith('LIMIT 0')) { if (failAt === 'probe') throw new DoorRefusal('wrangler d1 execute exited 1'); return [] }
    if (q.includes("'eval:lease'")) {
      if (q.startsWith('INSERT')) { leaseHeld = failAt !== 'lease'; return [] }
      if (q.startsWith('DELETE')) { leaseHeld = false; return [] }
      if (q.startsWith('SELECT value_json')) return failAt === 'lease' ? [{ value_json: JSON.stringify({ tag: 'product:other', until: 9e15 }) }] : leaseHeld ? [{ value_json: JSON.stringify({ tag: 'product:7-1', until: 9e15 }) }] : []
      if (q.startsWith('SELECT 1')) return leaseHeld ? [{ one: 1 }] : []
    }
    if (q.includes("key = 'hub:shop'") && q.startsWith('SELECT')) return failAt === 'shop' ? [{ value_json: 'example-x.myshopify.com' }] : []
    if (q.includes('AS now')) return [{ now: 1_700_000_000_000 }]
    return []
  }
  const doFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    http.push(`${method} ${url.host}${url.pathname}`)
    const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.host === 'pages.example.test') return failAt === 'page' ? new Response('', { status: 404 }) : new Response(renderPage(READ_SIDE_CASES.find((c) => c.id === 'RS-WW1')!))
    if (url.pathname === '/api/me') return failAt === 'me' ? j(500, {}) : j(200, { evalBrand: true, memberId: 'm_lena' })
    if (url.pathname === '/api/usage') return j(200, { total: { minor: failAt === 'room' ? 4900 : 100 }, cap: { minor: 5000 } })
    if (url.pathname === '/api/settings/technical') return j(200, { items: effort === undefined ? [] : [{ key: 'tm:sonnet:effort', value: effort, rev: effortRev }] })
    if (url.pathname === '/api/grants' && method === 'GET') return j(200, { items: [...grants].map(([id, live]) => ({ id, rev: 1, live })) })
    if (url.pathname === '/api/grants') { grants.set(`g${grants.size + 1}`, true); return j(201, {}) }
    const end = /^\/api\/grants\/(.+)\/end$/.exec(url.pathname)
    if (end) { grants.set(end[1]!, false); return j(200, {}) }
    if (url.host === 'inhouse.example.test' && method === 'PUT') {
      if (failAt === 'effort') return j(403, {})
      effort = (JSON.parse(String(init!.body)) as { value: string }).value
      effortRev++
      return j(200, {})
    }
    return j(404, {})
  }) as typeof fetch
  const env = {
    INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_RUN: '7-1', INHOUSE_EVAL_ORIGIN: 'https://brand.example.test', INHOUSE_EVAL_INHOUSE_ORIGIN: 'https://inhouse.example.test',
    INHOUSE_EVAL_INHOUSE_AUD: 'aud-inhouse', INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 'secret', ...env0,
  }
  const sessions = { async preflight() { if (failAt === 'r2') throw new DoorRefusal('R2 preflight answered 403') }, async parts() { return [] } }
  const signIn = async () => ({ 'Cf-Access-Jwt-Assertion': 'jwt' })
  return { run, doFetch, env, sessions, signIn, sql, http, state: () => ({ leaseHeld, effort, liveGrants: [...grants.values()].filter(Boolean).length }) }
}
const env0 = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'tok' }

describe('wireEval', () => {
  const wire = (f: ReturnType<typeof fakeEval>, register?: (c: () => Promise<string[]>) => void) => wireEval({
    env: f.env, model: 'claude-sonnet-5-5', budgetUsd: 10, cases: READ_SIDE_CASES, pageOrigin: 'https://pages.example.test', note: () => {},
    fetch: f.doFetch, run: f.run, signIn: f.signIn, signInhouse: f.signIn, sessions: f.sessions, ...(register ? { register } : {}),
  })
  it('passes its preflight, pins Medium, and its close puts the effort back, ends grants and gives the lease back, once however often it is called', async () => {
    const f = fakeEval(null)
    const w = await wire(f)
    expect(f.state()).toMatchObject({ leaseHeld: true, effort: 'Medium', liveGrants: 0 })
    expect(f.sql.some((q) => q.startsWith('SELECT text FROM memories') && q.endsWith('LIMIT 0'))).toBe(true)
    const [a, b] = [w.close(), w.close()]
    expect(a).toBe(b)
    expect(await a).toEqual([])
    expect(f.state()).toMatchObject({ leaseHeld: false, effort: 'High', liveGrants: 0 })
    expect(f.http.filter((h) => h.startsWith('PUT inhouse')).length).toBe(2)
  })
  for (const failAt of ['me', 'tables', 'probe', 'r2', 'page', 'lease', 'shop', 'room', 'effort']) {
    it(`a refusal at ${failAt} stops before any spend and leaves no lease, effort or grant behind`, async () => {
      const f = fakeEval(failAt)
      let registered = false
      await expect(wire(f, () => { registered = true })).rejects.toThrow()
      expect(registered).toBe(true)
      expect(f.state()).toMatchObject({ leaseHeld: false, effort: 'High', liveGrants: 0 })
      expect(f.http.some((h) => h.includes('/turns'))).toBe(false)
    })
  }
})

describe('wireProof', () => {
  it('reaches the eval-build guard: a PR database whose deployment says evalBrand is refused before any write', async () => {
    const writes: string[] = []
    const raw = { current: async () => ({ status: 200, bytes: new Uint8Array(), json: { evalBrand: true, memberId: 'm_x' } }), admin: async () => ({ status: 200, bytes: new Uint8Array(), json: {} }) }
    await expect(wireProof({ env: { ...env, INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-pr7-db' }, pr: 7, api: (async () => ({ status: 200, json: {}, text: '' })) as never, raw, scenarioOf: () => 'x', note: () => {}, run: async (q) => { writes.push(q); return [] } }))
      .rejects.toThrow(/this is the eval build/)
    expect(writes).toEqual([])
  })
  it('refuses a database that does not hold the probe chat the deployment just made', async () => {
    const raw = { current: async (method: string) => ({ status: method === 'POST' ? 201 : 200, bytes: new Uint8Array(), json: { memberId: 'm_x' } }), admin: async () => ({ status: 200, bytes: new Uint8Array(), json: {} }) }
    await expect(wireProof({ env: { ...env, INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-pr7-db' }, pr: 7, api: (async () => ({ status: 200, json: {}, text: '' })) as never, raw: raw as never, scenarioOf: () => 'x', note: () => {}, run: async () => [] }))
      .rejects.toThrow(/does not hold the chat/)
  })
})
