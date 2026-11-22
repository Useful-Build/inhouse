// The deployment-facing pieces' refusals: the R2 reader's bucket, key and token rules, the row reader's shapes, the effort pin
// and its put-back, which cases the product target serves now, and the proof mode's guards.
import { describe, expect, it } from 'vitest'
import { DoorRefusal, type RunSql } from '../../targets/door.ts'
import { liveOnProduct, parseReadSideArgs } from '../args.ts'
import { P5, PAGE, READ_SIDE_CASES, TEAM } from '../cases.ts'
import { main } from '../cli.ts'
import { defaultLabel, effortKey, pinEffort, type SettingsApi } from './effort.ts'
import { createSessionReader } from './r2.ts'
import { createRowReader } from './rows.ts'
import { READ_SIDE_ENV, wireProof } from './setup.ts'

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
  it('the command line runs the product preflight before making the results directory, and a refusal is exit 2 with no spend', async () => {
    const errs: string[] = []
    const out = `/nonexistent-read-side-${Date.now()}`
    const code = await main(['--target', 'product', '--model', 'claude-sonnet-5-5', '--out', out, '--paid', '--budget', '50', '--page-origin', 'https://pages.example.test'], {
      git: (a) => (a[0] === 'rev-parse' ? 'abc1234' : ''), log: () => {}, err: (m) => errs.push(m), env: {},
      wire: async () => { throw new Error('read-side: refusing: preflight failed') },
      onSignals: () => { throw new Error('no handlers before the preflight passes') },
    })
    expect(code).toBe(2)
    expect(errs.join('\n')).toContain('preflight failed')
  })
})
