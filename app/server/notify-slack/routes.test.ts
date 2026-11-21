// Routes F, G and H (p5-w4.md section 10, brief "Tests" 12), on the real migrations with a fake DeliveryGateway. Ways
// they can fail, written down first:
//  1. a Member reaches the hub or changes the list (the matrix refuses first; the handler refuses again);
//  2. a shared, archived, private or non-member channel gets listed, or two listed channels share a lowercase name;
//  3. a stale `ifRev` changes anything, or two alerts channels exist at once;
//  4. a change lands without its one audit line, or a no-op save writes a line.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ErrorBodySchema } from '../../shared/contract/common.ts'
import type { HubResult, SlackChannel } from '../../hub/index/contract.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { ctx, person, personPrincipal, reqId } from '../db/test-support.ts'
import { availableNotifyChannels, listNotifyChannels, putNotifyChannels } from './routes.ts'
import type { ChannelsBinding, NotifyRouteCtx } from './routes.ts'

const db = env.DB
const stores = openStores(env)
let u = 0
const uniq = () => `${++u}-${Math.random().toString(36).slice(2, 7)}`

const SLACK: Record<string, SlackChannel> = {
  C0TEST0001: { id: 'C0TEST0001', name: 'ops-alerts', isMember: true, shared: false, archived: false, private: false },
  C0TEST0002: { id: 'C0TEST0002', name: 'general', isMember: true, shared: false, archived: false, private: false },
  C0TEST0003: { id: 'C0TEST0003', name: 'partner-shared', isMember: true, shared: true, archived: false, private: false },
  C0TEST0004: { id: 'C0TEST0004', name: 'old-launch', isMember: true, shared: false, archived: true, private: false },
  C0TEST0005: { id: 'C0TEST0005', name: 'design', isMember: false, shared: false, archived: false, private: false },
  C0TEST0006: { id: 'C0TEST0006', name: 'leadership', isMember: true, shared: false, archived: false, private: true },
  C0TEST0007: { id: 'C0TEST0007', name: 'OPS-ALERTS', isMember: true, shared: false, archived: false, private: false },
}

function fakeHub() {
  const calls: string[] = []
  const hub: ChannelsBinding = {
    async listChannels(scope) {
      calls.push(`list:${scope.kind}`)
      return { ok: true, value: { channels: Object.values(SLACK).filter(c => !c.archived && !c.private), nextCursor: null } }
    },
    async checkChannel(scope, req): Promise<HubResult<SlackChannel>> {
      calls.push(`check:${scope.kind}:${req.channelId}`)
      const c = SLACK[req.channelId]
      return c ? { ok: true, value: c } : { ok: false, error: { code: 'connect_refused', message: 'connect refused by the provider: not_found' } }
    },
  }
  return { hub, calls }
}

async function admin(): Promise<Principal> {
  return personPrincipal(await person(stores, { email: `a-${uniq()}@example.test`, subject: `a-${uniq()}`, role: 'admin' }), 'admin')
}
async function memberP(): Promise<Principal> {
  return personPrincipal(await person(stores, { email: `m-${uniq()}@example.test`, subject: `m-${uniq()}`, role: 'member' }), 'member')
}
async function inhouse(): Promise<Principal> {
  const id = await stores.members.resolveInhouse({ subject: `ih-${uniq()}`, email: `ih-${uniq()}@example.test`, requestId: reqId(), nowMs: 1 })
  return { kind: 'inhouse', memberId: id.memberId, subject: id.subject, grant: null, requestId: reqId(), expMs: 4_102_444_800_000 }
}

function routeCtx(p: Principal, hub: ChannelsBinding, init: { method?: string; path: string; body?: unknown }): NotifyRouteCtx {
  return { ...ctx(stores, p, init).c, env: { HUB_DELIVERY: hub as unknown as Service } } as NotifyRouteCtx
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> })
const put = (p: Principal, hub: ChannelsBinding, body: unknown) => putNotifyChannels(routeCtx(p, hub, { method: 'PUT', path: '/api/notify/channels', body }))
const lines = async () => (await db.prepare("SELECT args_json FROM audit_log WHERE action = 'notify.channels' ORDER BY id").all<{ args_json: string }>()).results.map(r => JSON.parse(r.args_json) as Record<string, unknown>)
const rev = async () => ((await listNotifyChannels(ctx(stores, await memberP(), { path: '/api/notify/channels' }).c).then(r => r.json())) as { rev: number }).rev

describe('routes F, G and H', () => {
  it('a Member reads the list but is refused on G and H before any hub call', async () => {
    const m = await memberP()
    const { hub, calls } = fakeHub()
    expect((await json(await listNotifyChannels(ctx(stores, m, { path: '/api/notify/channels' }).c))).status).toBe(200)
    expect((await availableNotifyChannels(routeCtx(m, hub, { path: '/api/notify/channels/available' }))).status).toBe(403)
    expect((await put(m, hub, { channelIds: ['C0TEST0001'], ifRev: 0 })).status).toBe(403)
    expect(calls).toEqual([])
  })

  it('G lists public channels, shared and non-member ones disabled with the reason', async () => {
    const { hub, calls } = fakeHub()
    const r = await json(await availableNotifyChannels(routeCtx(await admin(), hub, { path: '/api/notify/channels/available' })))
    expect(r.body).toEqual({
      channels: [
        { channelId: 'C0TEST0001', name: 'ops-alerts' }, { channelId: 'C0TEST0002', name: 'general' },
        { channelId: 'C0TEST0003', name: 'partner-shared', disabled: 'shared_channel' }, { channelId: 'C0TEST0005', name: 'design', disabled: 'not_member' },
        { channelId: 'C0TEST0007', name: 'OPS-ALERTS' },
      ],
      nextCursor: null,
    })
    expect(calls).toEqual(['list:server'])
  })

  it('an Admin and the Inhouse team save; a stale ifRev conflicts with the current list; one audit line per change', async () => {
    const { hub, calls } = fakeHub()
    const before = (await lines()).length
    const r0 = await rev()
    const a = await json(await put(await admin(), hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 }))
    expect(a).toEqual({ status: 200, body: { rev: r0 + 1, channels: [{ channelId: 'C0TEST0002', name: 'general', alerts: false }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }] } })
    expect(calls).toEqual(['check:server:C0TEST0001', 'check:server:C0TEST0002'])
    const stale = await json(await put(await inhouse(), hub, { channelIds: ['C0TEST0002'], ifRev: r0 }))
    expect([stale.status, (stale.body.error as { reason?: string }).reason, ((stale.body.error as { current: { rev: number } }).current.rev)]).toEqual([409, undefined, r0 + 1])
    const b = await json(await put(await inhouse(), hub, { channelIds: ['C0TEST0002'], alertsChannelId: 'C0TEST0002', ifRev: r0 + 1 }))
    expect(b.body).toEqual({ rev: r0 + 2, channels: [{ channelId: 'C0TEST0002', name: 'general', alerts: true }] })
    // A no-op save bumps the rev and writes no line.
    await put(await admin(), hub, { channelIds: ['C0TEST0002'], alertsChannelId: 'C0TEST0002', ifRev: r0 + 2 })
    expect((await lines()).slice(before)).toEqual([
      { added: ['C0TEST0001', 'C0TEST0002'], removed: [], alerts: 'C0TEST0001' },
      { added: [], removed: ['C0TEST0001'], alerts: 'C0TEST0002' },
    ])
  })

  it.each([
    ['C0TEST0003', 'shared_channel'], ['C0TEST0004', 'archived'], ['C0TEST0006', 'not_public'], ['C0TEST0005', 'not_member'], ['C0TEST9999', 'not_found'],
  ])('adding %s is refused (%s) and changes nothing', async (channelId, reason) => {
    const { hub } = fakeHub()
    const r0 = await rev()
    const r = await json(await put(await admin(), hub, { channelIds: ['C0TEST0002', channelId], ifRev: r0 }))
    expect([r.status, (r.body.error as { reason: string }).reason]).toEqual([409, reason])
    expect(await rev()).toBe(r0)
  })

  it('two channels whose names differ only in case are refused (name_taken)', async () => {
    const { hub } = fakeHub()
    const r0 = await rev()
    const r = await json(await put(await admin(), hub, { channelIds: ['C0TEST0001', 'C0TEST0007'], ifRev: r0 }))
    expect([r.status, (r.body.error as { reason: string }).reason]).toEqual([409, 'name_taken'])
  })

  it('a second alerts channel is refused: the body names one, and the table refuses two', async () => {
    const { hub } = fakeHub()
    const r = await put(await admin(), hub, { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0002', ifRev: await rev() })
    expect(r.status).toBe(400)
    await db.prepare('DELETE FROM notify_channels').run()
    await db.prepare("INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES ('C0TEST0001', 'a', 1, 'm_system', 1)").run()
    await expect(db.prepare("INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES ('C0TEST0002', 'b', 1, 'm_system', 1)").run()).rejects.toThrow(/UNIQUE/)
    await expect(db.prepare("INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES ('C0TEST0003', 'A', 0, 'm_system', 1)").run()).rejects.toThrow(/UNIQUE/)
    await expect(db.prepare("INSERT INTO notify_channels (channel_id, name, alerts, added_by, added_at_ms) VALUES ('U0TEST0001', 'u', 0, 'm_system', 1)").run()).rejects.toThrow(/CHECK/)
  })

  it('every refusal body these routes send parses as the client reads it (ErrorBodySchema)', async () => {
    const { hub } = fakeHub()
    const p = await admin()
    const bodies = [
      await put(p, hub, { channelIds: ['C0TEST0003'], ifRev: await rev() }),
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0007'], ifRev: await rev() }),
      await put(p, hub, { channelIds: [], ifRev: 9999 }),
      await availableNotifyChannels(routeCtx(p, { ...hub, listChannels: async () => ({ ok: false, error: { code: 'paused', message: 'connector paused' } }) }, { path: '/api/notify/channels/available' })),
    ]
    for (const r of bodies) expect(ErrorBodySchema.safeParse(await r.json()).success, String(r.status)).toBe(true)
  })

  it('review round 1: two kept channels swapping names at Slack, or a chain of renames, save without a 500', async () => {
    const { hub } = fakeHub()
    const p = await admin()
    await db.prepare('DELETE FROM notify_channels').run()
    const r0 = await rev()
    expect((await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], ifRev: r0 })).status).toBe(200)
    // Slack now names them the other way round.
    const swapped = { ...SLACK.C0TEST0001!, name: 'general' }, swapped2 = { ...SLACK.C0TEST0002!, name: 'ops-alerts' }
    const renamed = { ...hub, checkChannel: async (_s: unknown, req: { channelId: string }) => ({ ok: true as const, value: req.channelId === 'C0TEST0001' ? swapped : swapped2 }) }
    const r = await json(await put(p, renamed as never, { channelIds: ['C0TEST0001', 'C0TEST0002'], ifRev: r0 + 1 }))
    expect(r).toEqual({ status: 200, body: { rev: r0 + 2, channels: [{ channelId: 'C0TEST0001', name: 'general', alerts: false }, { channelId: 'C0TEST0002', name: 'ops-alerts', alerts: false }] } })
    // A chain: 1 takes 2's name, 2 takes a new one.
    const chain = { ...hub, checkChannel: async (_s: unknown, req: { channelId: string }) => ({ ok: true as const, value: req.channelId === 'C0TEST0001' ? { ...swapped, name: 'ops-alerts' } : { ...swapped2, name: 'ops-old' } }) }
    const c = await json(await put(p, chain as never, { channelIds: ['C0TEST0001', 'C0TEST0002'], ifRev: r0 + 2 }))
    expect(c.status).toBe(200)
    expect((c.body.channels as { name: string }[]).map(x => x.name)).toEqual(['ops-alerts', 'ops-old'])
  })
})
