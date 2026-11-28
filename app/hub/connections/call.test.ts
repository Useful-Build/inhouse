// connectionCall (connections/call.ts, Stage 1 M4-R1, N35) against M4-F's fixture servers, through the SignIn core.
// Every "nothing left" claim is read from the fixtures' own request log, with a control in the same test that the path
// ran. Ways it could go wrong, written first: the re-read after an await skipped (N53's plant), so a pause, a remove, a
// credential change or a trust flip that lands during an await is missed and the request still leaves; an await
// between the last check and the send; a credential sent to where a redirect points; a write stopped before its POST
// reported `sent: 'unknown'`, or one stopped after it reported `sent: 'no'`.
import { beforeEach, describe, expect, it } from 'vitest'
import { createMcpFixtures, type McpFixtures } from '../../test/upstreams/mcp/index'
import { MODERN_KEY } from '../../test/upstreams/mcp/modern'
import { HOSTS } from '../../test/upstreams/mcp/wire'
import { parseKeyRing } from '../crypto/keyring'
import { EraCache } from '../connectors/mcp/sdk'
import type { Upstream } from '../oauth/http'
import { connectionCall, type CallHost, type ConnectionCallRequest } from './call'
import { connectionHooks, type ConnectionHooks } from './hooks'
import { prepareConnection } from './gateway'
import { checkRecord, withCredential, withPolicy, type ConnectionRecord } from './record'
import { binding, ConnWorld, deferred, inhouse, KEYED, OPEN, server } from './testing/kit'

let fx: McpFixtures
let w: ConnWorld
const ID = 'mcp:helpdesk'
const LIST: ConnectionCallRequest = { kind: 'list' }
const KEY_HOOK: ConnectionHooks['credentialFor'] = async () => ({ ok: true, value: { credential: { header: 'X-Api-Key', value: MODERN_KEY }, cls: 'key' } })

beforeEach(() => {
  fx = createMcpFixtures()
  w = new ConnWorld(fx.fetch)
})

/** The requests that reached a fixture endpoint. */
const reached = (url: string) => {
  const u = new URL(url)
  return fx.log.for(u.host, u.pathname)
}
const record = (): ConnectionRecord => w.raw(ID) as ConnectionRecord
/** Writes a changed record as a later package would (one whole put). */
const put = (r: ConnectionRecord) => {
  expect(checkRecord(r)).toEqual({ ok: true })
  w.store(ID).put('record', r)
}

async function prepare(url = OPEN, path: 'none' | 'key' = 'none') {
  const p = await prepareConnection(w.deps(), server, { actor: inhouse, slug: 'helpdesk', adminMaySignIn: false, binding: binding(url, { path }) })
  expect(p.ok).toBe(true)
  if (path === 'key') w.hooks.credentialFor = KEY_HOOK
}

/** The four changes the fence must catch, each as the hub makes it. */
const CHANGES: { name: string; code: string; apply(): Promise<unknown> | void }[] = [
  { name: 'a pause', code: 'paused', apply: () => w.core(ID).setPaused(ID, true) },
  { name: 'a remove', code: 'not_configured', apply: () => w.core(ID).removeConnection(ID) },
  { name: 'a credential change', code: 'definition_changed', apply: () => put(withCredential(record(), 'key', { kid: 'k1', iv: 'aaaaaaaaaaaaaaaa', ct: 'bbbbbbbbbbbbbbbbbbbbbbbb' }, record().state)) },
  { name: 'a trust flip', code: 'definition_changed', apply: () => put(withPolicy(record(), { trusted: true })) },
  // #732: a state change alone (generation and policyRev the same) stops a call too.
  { name: 'a state change', code: 'needs_key', apply: () => put({ ...record(), state: 'needs_key' }) },
]

describe('the control: a call goes through', () => {
  it('an open connection lists its tools from the wire, no credential, no hook asked', async () => {
    await prepare()
    w.hooks.credentialFor = async () => {
      throw new Error('an open connection asks for no credential')
    }
    const r = await w.core(ID).connectionCall(ID, LIST)
    expect(r.ok && r.value.kind === 'list' && r.value.tools.map(t => t.name)).toContain('notes_search')
    // A probe, then every page.
    const rpcs = reached(OPEN).map(e => e.rpc)
    expect(rpcs[0]).toBe('server/discover')
    expect(rpcs.length).toBeGreaterThan(1)
    expect(rpcs.slice(1).every(m => m === 'tools/list')).toBe(true)
    expect(reached(OPEN).every(e => e.credential === 'none')).toBe(true)
  })

  it('a key connection sends the key from credentialFor, only to its endpoint', async () => {
    await prepare(KEYED, 'key')
    const r = await w.core(ID).connectionCall(ID, LIST)
    expect(r.ok).toBe(true)
    expect(reached(KEYED).length).toBeGreaterThan(0)
    expect(reached(KEYED).every(e => e.credential === 'key')).toBe(true)
    expect(fx.log.entries.every(e => e.path === '/key/mcp')).toBe(true)
  })

  it('a hook not built yet sends nothing: no credential for a key path, no read or write past beforeCall', async () => {
    await prepare(KEYED, 'key')
    w.hooks.credentialFor = connectionHooks.credentialFor
    expect(await w.core(ID).connectionCall(ID, LIST)).toMatchObject({ ok: false, error: { code: 'not_built' }, sent: 'no' })
    expect(fx.log.entries).toEqual([])
  })
})

describe('a call interleaved with a change is stopped at the last check', () => {
  for (const change of CHANGES) {
    it(`${change.name} during the address check's await: stopped, and nothing reaches the server`, async () => {
      await prepare()
      const gate = deferred<boolean>()
      const asked = deferred()
      w.resolvePublic = async () => {
        asked.resolve()
        return gate.promise
      }
      const call = w.core(ID).connectionCall(ID, LIST)
      await asked.promise
      await change.apply()
      gate.resolve(true)
      expect(await call).toMatchObject({ ok: false, error: { code: change.code }, sent: 'no' })
      expect(reached(OPEN)).toEqual([])
    })

    it(`${change.name} during credentialFor: stopped before any request`, async () => {
      await prepare(KEYED, 'key')
      const gate = deferred()
      const asked = deferred()
      w.hooks.credentialFor = async ctx => {
        asked.resolve()
        await gate.promise
        return KEY_HOOK(ctx)
      }
      const call = w.core(ID).connectionCall(ID, LIST)
      await asked.promise
      await change.apply()
      gate.resolve()
      expect(await call).toMatchObject({ ok: false, error: { code: change.code }, sent: 'no' })
      expect(reached(KEYED)).toEqual([])
    })
  }

  it('at every await of a call, a pause stops it and nothing more leaves after the pause (control: no pause, it lists)', async () => {
    await prepare(KEYED, 'key')
    const awaits = 6
    for (let k = 0; k < awaits; k++) {
      fx = createMcpFixtures()
      w = new ConnWorld(fx.fetch)
      await prepare(KEYED, 'key')
      let n = 0
      let atPause = -1
      const at = async () => {
        if (n++ === k) {
          await w.core(ID).setPaused(ID, true)
          atPause = reached(KEYED).length
        }
      }
      w.hooks.credentialFor = async ctx => {
        await at()
        return KEY_HOOK(ctx)
      }
      w.resolvePublic = async () => {
        await at()
        return true
      }
      const r = await w.core(ID).connectionCall(ID, LIST)
      if (atPause === -1) {
        // Fewer awaits than k: the control, the list went through untouched.
        expect(r.ok).toBe(true)
        continue
      }
      expect(r, `pause at await ${k}`).toMatchObject({ ok: false, error: { code: 'paused' } })
      expect(reached(KEYED).length, `pause at await ${k}`).toBe(atPause)
    }
  })

  it('a change after the request left: the answer is dropped and the call refused', async () => {
    await prepare()
    w.upstream = async req => {
      const res = await fx.fetch(req)
      if (reached(OPEN).some(e => e.rpc === 'tools/list')) await w.core(ID).setPaused(ID, true)
      return res
    }
    expect(await w.core(ID).connectionCall(ID, LIST)).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    // The pause landed with the first page's answer: no later page was asked.
    expect(reached(OPEN).map(e => e.rpc)).toEqual(['server/discover', 'tools/list'])
  })
})

describe('the last check and the send have no await between them', () => {
  it('the record is read in the same synchronous run that sends each request', async () => {
    await prepare()
    let armed = false
    let sends = 0
    const read = () => {
      armed = true
      queueMicrotask(() => {
        armed = false
      })
      return record()
    }
    const base: Upstream = req => {
      expect(armed, 'an await passed between the last read of the record and the send').toBe(true)
      sends++
      return fx.fetch(req)
    }
    const host: CallHost = {
      accountId: ID,
      read,
      commit: () => null,
      now: () => w.clock.ms,
      upstream: async () => base,
      resolvePublic: async () => true,
      keyring: () => parseKeyRing(w.ringJson),
      eras: new EraCache(),
      hooks: connectionHooks,
      timeoutMs: 2_000,
    }
    expect((await connectionCall(host, LIST)).ok).toBe(true)
    // The control: every request that reached the server went through that check.
    expect(sends).toBeGreaterThan(1)
    expect(sends).toBe(reached(OPEN).length)
  })
})

describe('a write: sent is no only when no tools/call left', () => {
  async function liveWithWriteTool() {
    await prepare()
    const listed = await w.core(ID).connectionCall(ID, LIST)
    const def = listed.ok && listed.value.kind === 'list' ? listed.value.tools.find(t => t.name === 'notes_write')! : null
    expect(def).not.toBeNull()
    const r = record()
    put({ ...r, state: 'live', tools: [{ name: def!.name, hubName: 'helpdesk_notes_write', title: null, description: '', inputSchema: def!.inputSchema as Record<string, unknown>, readOnlyHint: null, defHash: 'a'.repeat(64), mode: 'write', confirmedHash: 'a'.repeat(64), confirmedGen: r.generation, hidden: null }] })
    w.hooks.beforeCall = () => null
    w.hooks.write = ctx => ctx.send()
    fx.log.clear()
    const now = record()
    return { kind: 'write', tool: 'notes_write', args: { folder: 'inbox', text: 'hello' }, expect: { generation: now.generation, defHash: 'a'.repeat(64), policyRev: now.policyRev } } as const
  }
  const toolCalls = () => reached(OPEN).filter(e => e.rpc === 'tools/call').length

  it('the control: one POST, the result', async () => {
    const req = await liveWithWriteTool()
    expect(await w.core(ID).connectionCall(ID, req)).toMatchObject({ ok: true, value: { kind: 'write' } })
    expect(toolCalls()).toBe(1)
  })

  it('stopped at the last check before its POST: sent no, and the server saw no tools/call', async () => {
    const req = await liveWithWriteTool()
    // Paused at the first request's address check (the era is cached from the list, so that is the tools/call itself).
    w.resolvePublic = async () => {
      await w.core(ID).setPaused(ID, true)
      return true
    }
    expect(await w.core(ID).connectionCall(ID, req)).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'no' })
    expect(toolCalls()).toBe(0)
  })

  it('stopped after its POST left: sent unknown, never no', async () => {
    const req = await liveWithWriteTool()
    w.upstream = async r => {
      const res = await fx.fetch(r)
      if (toolCalls() > 0) await w.core(ID).setPaused(ID, true)
      return res
    }
    expect(await w.core(ID).connectionCall(ID, req)).toMatchObject({ ok: false, error: { code: 'paused' }, sent: 'unknown' })
    expect(toolCalls()).toBe(1)
  })

  it('pins that are not the record\'s now: refused before anything, sent no', async () => {
    const req = await liveWithWriteTool()
    expect(await w.core(ID).connectionCall(ID, { ...req, expect: { ...req.expect, policyRev: req.expect.policyRev + 1 } })).toMatchObject({ ok: false, error: { code: 'definition_changed' }, sent: 'no' })
    expect(fx.log.entries).toEqual([])
  })
})

describe('a credential never follows a redirect', () => {
  it('a key connection whose endpoint redirects: the key reaches only the endpoint, never where the redirect points', async () => {
    const moved = `https://${HOSTS.modern}/moved/mcp`
    await prepare(moved, 'key')
    const r = await w.core(ID).connectionCall(ID, LIST)
    expect(r.ok).toBe(false)
    expect(reached(moved).length).toBeGreaterThan(0)
    expect(reached(OPEN)).toEqual([])
    expect(fx.log.entries.every(e => e.path === '/moved/mcp')).toBe(true)
  })

  it('a redirect to the login server\'s token address: nothing reaches it', async () => {
    const token = `https://${HOSTS.login}/token`
    await prepareConnection(w.deps(), server, { actor: inhouse, slug: 'helpdesk', adminMaySignIn: false, binding: binding(KEYED, { path: 'key', extra: { token } }) })
    w.hooks.credentialFor = KEY_HOOK
    w.upstream = async req => (new URL(req.url).host === HOSTS.modern ? new Response(null, { status: 307, headers: { Location: token } }) : fx.fetch(req))
    expect((await w.core(ID).connectionCall(ID, LIST)).ok).toBe(false)
    expect(fx.log.for(HOSTS.login)).toEqual([])
  })
})

describe('each check of the call is pinned (#732)', () => {
  it('the DNS verdict at the send: a name that doesn\'t resolve public sends nothing', async () => {
    await prepare()
    w.resolvePublic = async () => false
    expect(await w.core(ID).connectionCall(ID, LIST)).toMatchObject({ ok: false, error: { code: 'upstream_unavailable' }, sent: 'no' })
    expect(reached(OPEN)).toEqual([])
  })

  it('the destination check at the start: a stored private endpoint is refused by name, before any hop, even with a resolver that says public', async () => {
    await prepare()
    put({ ...record(), binding: { ...record().binding, destinations: { ...record().binding.destinations!, mcp: 'https://10.0.0.7/mcp' } } })
    w.resolvePublic = async () => true
    const sent: string[] = []
    w.upstream = async req => (sent.push(req.url), new Response('{}'))
    expect(await w.core(ID).connectionCall(ID, LIST)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: destination_address' }, sent: 'no' })
    expect(sent).toEqual([])
  })

  it('beforeCall is asked at the last check: a refusal that turns on during the address check\'s await stops the hop', async () => {
    await prepare()
    let refuse = false
    w.hooks.beforeCall = () => (refuse ? 'definition_changed' : null)
    w.resolvePublic = async () => ((refuse = true), true)
    expect(await w.core(ID).connectionCall(ID, LIST)).toMatchObject({ ok: false, error: { code: 'definition_changed' }, sent: 'no' })
    expect(reached(OPEN)).toEqual([])
  })

  it('a record its prepare never listed (a crash before the index write) is unusable until listed (#733)', async () => {
    await prepare()
    put({ ...record(), listed: false } as ConnectionRecord)
    expect(await w.core(ID).connectionCall(ID, LIST)).toMatchObject({ ok: false, error: { code: 'not_configured' }, sent: 'no' })
    expect(reached(OPEN)).toEqual([])
  })
})

describe('a call that has answered never sends afterwards (Neon round 1, #2)', () => {
  it('the address check stalls past the request\'s deadline: sent no, and when it settles later nothing leaves', async () => {
    w.timeoutMs = 50
    await prepare()
    const stall = deferred<boolean>()
    w.resolvePublic = () => stall.promise
    const r = await w.core(ID).connectionCall(ID, LIST)
    expect(r).toMatchObject({ ok: false, sent: 'no' })
    // The orphaned hop's address check now says public: it must still not send.
    stall.resolve(true)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(reached(OPEN)).toEqual([])
  })
})
