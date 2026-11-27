// Routes F, G and H (p5-w4.md section 10, brief "Tests" 12), on the real migrations with a fake DeliveryGateway. Ways
// they can fail, written down first:
//  1. a Member reaches the hub or changes the list (the matrix refuses first; the handler refuses again);
//  2. a shared, archived, private or non-member channel gets listed, or two listed channels share a lowercase name;
//  3. a stale `ifRev` changes anything, or two alerts channels exist at once;
//  4. a change lands without its one audit line, or a no-op save writes a line;
//  5. (Stage 1 M2-N, Q3 = A) marking a channel for alerts doesn't give the brand's grant to post there, gives it when it
//     mustn't (the operation off, Slack not connected, the Inhouse team's save, a re-save that doesn't move the mark),
//     or moving the mark off doesn't take it back; the list doesn't show the grant with its scope and daily limit.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { ErrorBodySchema } from '../../shared/contract/common.ts'
import type { HubResult, SlackChannel } from '../../hub/index/contract.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { ctx, person, personPrincipal, reqId } from '../db/test-support.ts'
import { account, ceiling, resetPermissions } from '../permissions/test-support.ts'
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
/** Stage 1 M3-C (N27): no ceiling row for `slack.channel.post` here, so posting is off and the list shows no limit. */
const OFF = { on: false } as const
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
    expect(a).toEqual({ status: 200, body: { rev: r0 + 1, channels: [{ channelId: 'C0TEST0002', name: 'general', alerts: false }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }], posting: OFF } })
    expect(calls).toEqual(['check:server:C0TEST0001', 'check:server:C0TEST0002'])
    const stale = await json(await put(await inhouse(), hub, { channelIds: ['C0TEST0002'], ifRev: r0 }))
    expect([stale.status, (stale.body.error as { reason?: string }).reason, ((stale.body.error as { current: { rev: number } }).current.rev)]).toEqual([409, undefined, r0 + 1])
    const b = await json(await put(await inhouse(), hub, { channelIds: ['C0TEST0002'], alertsChannelId: 'C0TEST0002', ifRev: r0 + 1 }))
    expect(b.body).toEqual({ rev: r0 + 2, channels: [{ channelId: 'C0TEST0002', name: 'general', alerts: true }], posting: OFF })
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
    await db.prepare('DELETE FROM notify_channels').run()
    const bodies = [
      await put(p, hub, { channelIds: ['C0TEST0003'], ifRev: await rev() }),
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0007'], ifRev: await rev() }),
      await put(p, hub, { channelIds: [], ifRev: 9999 }),
      await availableNotifyChannels(routeCtx(p, { ...hub, listChannels: async () => ({ ok: false, error: { code: 'paused', message: 'connector paused' } }) }, { path: '/api/notify/channels/available' })),
    ]
    for (const r of bodies) expect(ErrorBodySchema.safeParse(await r.json()).success, String(r.status)).toBe(true)
  })

  it('review round 1: the store saves kept channels swapping names, or a chain of renames, without a constraint error', async () => {
    const store = stores.notify
    await db.prepare('DELETE FROM notify_channels').run()
    const who = (await admin() as Extract<Principal, { kind: 'person' }>).memberId
    const at = (n: number) => ({ actorId: who, requestId: reqId(), nowMs: n })
    let list = await store.list()
    const first = await store.save({ channels: [{ channelId: 'C0TEST0001', name: 'ops-alerts' }, { channelId: 'C0TEST0002', name: 'general' }], alertsChannelId: null, ifRev: list.rev }, at(1))
    if (!('ok' in first)) throw new Error('first save conflicted')
    const swap = await store.save({ channels: [{ channelId: 'C0TEST0001', name: 'general' }, { channelId: 'C0TEST0002', name: 'ops-alerts' }], alertsChannelId: null, ifRev: first.ok.rev }, at(2))
    expect(swap).toEqual({ ok: { rev: first.ok.rev + 1, channels: [{ channelId: 'C0TEST0001', name: 'general', alerts: false }, { channelId: 'C0TEST0002', name: 'ops-alerts', alerts: false }], posting: OFF } })
    list = await store.list()
    const chain = await store.save({ channels: [{ channelId: 'C0TEST0001', name: 'ops-alerts' }, { channelId: 'C0TEST0002', name: 'ops-old' }], alertsChannelId: null, ifRev: list.rev }, at(3))
    expect('ok' in chain && chain.ok.channels.map(c => c.name)).toEqual(['ops-alerts', 'ops-old'])
  })

  it('review round 1: only added channels are checked at Slack, so removing or moving the alerts mark saves while Slack is paused', async () => {
    const { hub, calls } = fakeHub()
    const p = await admin()
    await db.prepare('DELETE FROM notify_channels').run()
    const r0 = await rev()
    expect((await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 })).status).toBe(200)
    const paused = { ...hub, checkChannel: async () => ({ ok: false as const, error: { code: 'paused' as const, message: 'connector paused' } }) }
    const moved = await json(await put(p, paused, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0002', ifRev: r0 + 1 }))
    expect(moved.body).toEqual({ rev: r0 + 2, channels: [{ channelId: 'C0TEST0002', name: 'general', alerts: true }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: false }], posting: OFF })
    const removed = await json(await put(p, paused, { channelIds: ['C0TEST0002'], alertsChannelId: 'C0TEST0002', ifRev: r0 + 2 }))
    expect(removed.status).toBe(200)
    // Adding one still needs Slack.
    const added = await json(await put(p, paused, { channelIds: ['C0TEST0002', 'C0TEST0001'], ifRev: r0 + 3 }))
    expect([added.status, (added.body.error as { reason: string }).reason]).toEqual([503, 'slack_not_connected'])
    // Kept channels were asked too (best effort), and their failures didn't stop the saves.
    expect(calls).toEqual(['check:server:C0TEST0001', 'check:server:C0TEST0002'])
  })

  it('review round 2: a rename at Slack, and two kept channels swapping names, reach the list through the route', async () => {
    const { hub } = fakeHub()
    const p = await admin()
    await db.prepare('DELETE FROM notify_channels').run()
    const r0 = await rev()
    expect((await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], ifRev: r0 })).status).toBe(200)
    const named = (names: Record<string, string>) => ({ ...hub, checkChannel: async (_s: unknown, req: { channelId: string }) => ({ ok: true as const, value: { ...SLACK[req.channelId]!, name: names[req.channelId] ?? SLACK[req.channelId]!.name } }) })
    const renamed = await json(await put(p, named({ C0TEST0002: 'general-chat' }), { channelIds: ['C0TEST0001', 'C0TEST0002'], ifRev: r0 + 1 }))
    expect(renamed.body).toEqual({ rev: r0 + 2, channels: [{ channelId: 'C0TEST0002', name: 'general-chat', alerts: false }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: false }], posting: OFF })
    const swapped = await json(await put(p, named({ C0TEST0001: 'general-chat', C0TEST0002: 'ops-alerts' }), { channelIds: ['C0TEST0001', 'C0TEST0002'], ifRev: r0 + 2 }))
    expect(swapped).toEqual({ status: 200, body: { rev: r0 + 3, channels: [{ channelId: 'C0TEST0001', name: 'general-chat', alerts: false }, { channelId: 'C0TEST0002', name: 'ops-alerts', alerts: false }], posting: OFF } })
    // A kept channel that became shared still saves (its posts are refused at the hub); a thrown check keeps the name.
    const shared = { ...hub, checkChannel: async (_s: unknown, req: { channelId: string }) => (req.channelId === 'C0TEST0001' ? { ok: true as const, value: { ...SLACK.C0TEST0001!, name: 'general-chat', shared: true } } : Promise.reject(new Error('hub down'))) }
    const kept = await json(await put(p, shared as never, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 + 3 }))
    expect(kept.body).toEqual({ rev: r0 + 4, channels: [{ channelId: 'C0TEST0001', name: 'general-chat', alerts: true }, { channelId: 'C0TEST0002', name: 'ops-alerts', alerts: false }], posting: OFF })
  })

  describe('M2-N: the alerts mark is the brand\'s grant for that channel', () => {
    const grants = async () => (await db.prepare(
      "SELECT id, holder, holder_member, account_id, account_gen, operation, scope_key, per_day, granted_by, granted_role, ceiling_rev, revoked_at_ms, revoke_reason FROM permission_grants WHERE holder = 'brand' ORDER BY granted_at_ms, id",
    ).all<Record<string, unknown>>()).results
    const permissionLines = async (since: number) => (await db.prepare("SELECT action, args_json FROM audit_log WHERE id > ? AND action LIKE 'permission.%' ORDER BY id").bind(since).all<{ action: string; args_json: string }>()).results
      .map(l => ({ action: l.action, ...(JSON.parse(l.args_json) as Record<string, unknown>) }) as Record<string, unknown>)
    const lastLine = async () => (await db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM audit_log').first<number>('id'))!
    async function brand(o: { ceiling?: boolean; slack?: boolean; perDayMax?: number } = {}) {
      await resetPermissions(db)
      if (o.ceiling ?? true) await ceiling(db, 'slack.channel.post', { enabled: true, perDayMax: o.perDayMax ?? 50, loweredRev: 3 })
      if (o.slack ?? true) await account(db, 'slack:workspace', 7_000)
    }
    const list = async () => (await json(await listNotifyChannels(ctx(stores, await memberP(), { path: '/api/notify/channels' }).c))).body

    it('an admin marking a channel creates the grant, listed with its scope and daily limit; moving the mark takes it back', async () => {
      await brand({ perDayMax: 20 })
      const { hub } = fakeHub()
      const p = await admin()
      const who = (p as Extract<Principal, { kind: 'person' }>).memberId
      const since = await lastLine()
      const r0 = await rev()
      const marked = await json(await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 }))
      const [g] = await grants()
      expect(g).toMatchObject({
        holder: 'brand', holder_member: null, account_id: 'slack:workspace', account_gen: 7_000, operation: 'slack.channel.post',
        scope_key: 'channelId=C0TEST0001', per_day: 50, granted_by: who, granted_role: 'admin', ceiling_rev: 3, revoked_at_ms: null,
      })
      // The daily limit a post meets now: the smaller of the grant's 50 and the ceiling's 20.
      const shown = { id: g!.id, scope: '#ops-alerts', perDay: 20 }
      expect(marked.body).toEqual({ rev: r0 + 1, channels: [{ channelId: 'C0TEST0002', name: 'general', alerts: false }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true, permission: shown }], posting: { on: true, perDay: 20 } })
      expect((await list()).channels).toEqual([{ channelId: 'C0TEST0002', name: 'general', alerts: false }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true, permission: shown }])
      // A re-save that keeps the mark makes no second grant.
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 + 1 })
      expect((await grants()).length).toBe(1)
      // Moving the mark: the old channel's grant ends (`removed`), the new one gets its own.
      const moved = await json(await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0002', ifRev: r0 + 2 }))
      const after = await grants()
      expect(after.map(x => [x.scope_key, x.revoked_at_ms === null ? 'live' : 'revoked', x.revoke_reason]).sort()).toEqual([['channelId=C0TEST0001', 'revoked', 'removed'], ['channelId=C0TEST0002', 'live', null]])
      expect((moved.body.channels as { channelId: string; permission?: unknown }[]).map(c => [c.channelId, c.permission !== undefined])).toEqual([['C0TEST0002', true], ['C0TEST0001', false]])
      // Unmarking takes the grant back; nothing is left.
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: null, ifRev: r0 + 3 })
      expect((await grants()).filter(x => x.revoked_at_ms === null)).toEqual([])
      expect((await permissionLines(since)).map(l => [l.action, l.holder ?? null, l.reason ?? null, l.perDay ?? null])).toEqual([
        ['permission.granted', 'brand', null, 50],
        ['permission.revoked', null, 'removed', null], ['permission.granted', 'brand', null, 50],
        ['permission.revoked', null, 'removed', null],
      ])
    })

    it('no grant without the operation on, without Slack connected, or from the Inhouse team; the list shows none', async () => {
      const { hub } = fakeHub()
      for (const [why, setup, p] of [
        ['the operation is off', { ceiling: false }, await admin()],
        ['Slack is not connected', { slack: false }, await admin()],
        ['the Inhouse team saved it', {}, await inhouse()],
      ] as const) {
        await brand(setup)
        await db.prepare('DELETE FROM notify_channels').run()
        const r = await json(await put(p, hub, { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: await rev() }))
        expect(r.status, why).toBe(200)
        expect(await grants(), why).toEqual([])
        expect((await list()).channels, why).toEqual([{ channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }])
      }
    })

    it('a grant removed in Permissions stays removed on a re-save; removing the channel ends it as channel_unlisted', async () => {
      await brand()
      const { hub } = fakeHub()
      const p = await admin()
      const r0 = await rev()
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 })
      const [g] = await grants()
      await db.prepare("UPDATE permission_grants SET revoked_at_ms = 1, revoke_reason = 'removed' WHERE id = ?").bind(g!.id).run()
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 + 1 })
      expect((await grants()).filter(x => x.revoked_at_ms === null)).toEqual([])
      expect((await list()).channels).toEqual([{ channelId: 'C0TEST0002', name: 'general', alerts: false }, { channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }])
      // Marked again (off, then on): a fresh grant; then the channel leaves the list and its grant ends with it.
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: null, ifRev: r0 + 2 })
      await put(p, hub, { channelIds: ['C0TEST0001', 'C0TEST0002'], alertsChannelId: 'C0TEST0001', ifRev: r0 + 3 })
      expect((await grants()).filter(x => x.revoked_at_ms === null).length).toBe(1)
      await put(p, hub, { channelIds: ['C0TEST0002'], alertsChannelId: null, ifRev: r0 + 4 })
      expect((await grants()).map(x => x.revoke_reason).sort()).toEqual(['channel_unlisted', 'removed'])
    })

    // Neon's review (round 1): the product dates Slack's connect by its own clock and the hub owns the sign-in; the first
    // write request's sync copies the hub's date in and revokes grants on any other generation. So the mark syncs first.
    it("the mark copies the hub's connection date in first, so the first post's sync keeps the grant", async () => {
      await brand()
      const { hub } = fakeHub()
      const HUB_GEN = 9_000
      const connect = {
        async listAccounts() {
          return { ok: true, value: [{ accountId: 'slack:workspace', connector: 'slack', status: { state: 'active', paused: false, connectedAt: { ms: HUB_GEN } } }] }
        },
      }
      const p = await admin()
      await db.prepare('DELETE FROM notify_channels').run()
      const r = await putNotifyChannels({ ...routeCtx(p, hub, { method: 'PUT', path: '/api/notify/channels', body: { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: await rev() } }), env: { HUB_DELIVERY: hub as unknown as Service, HUB_CONNECT: connect as unknown as Service } } as NotifyRouteCtx)
      expect(r.status).toBe(200)
      const [g] = await grants()
      expect(g).toMatchObject({ account_gen: HUB_GEN, revoked_at_ms: null })
      // The first post's sync (BrandAgent's hubAccounts, the same `syncFromHub`) finds nothing to change: the grant lives.
      expect(await stores.connectors.syncFromHub('slack:workspace', 'slack', { connectedAtMs: HUB_GEN, shop: null }, { actorId: 'm_system', requestId: reqId(), nowMs: 10_000 })).toBe(false)
      expect((await grants()).map(x => x.revoked_at_ms)).toEqual([null])
      // Without that sync (the hub unread) the grant would take the product's date and lapse at the first post's sync.
      await markAlertsWithout(p, hub)
    })
    /** Unmark, then mark with no HUB_CONNECT: the grant takes D1's date (7,000) and the hub's later sync (9,000) revokes it. */
    async function markAlertsWithout(p: Principal, hub: ChannelsBinding) {
      await db.prepare("UPDATE connector_accounts SET connected_at_ms = 7000 WHERE account_id = 'slack:workspace'").run()
      expect((await put(p, hub, { channelIds: ['C0TEST0001'], alertsChannelId: null, ifRev: await rev() })).status).toBe(200)
      expect((await put(p, hub, { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: await rev() })).status).toBe(200)
      const live = (await grants()).filter(x => x.revoked_at_ms === null)
      expect(live.map(x => x.account_gen)).toEqual([7_000])
      await stores.connectors.syncFromHub('slack:workspace', 'slack', { connectedAtMs: 9_000, shop: null }, { actorId: 'm_system', requestId: reqId(), nowMs: 11_000 })
      expect((await grants()).filter(x => x.revoked_at_ms === null)).toEqual([])
    }

    it('a stale save gives no grant', async () => {
      await brand()
      const { hub } = fakeHub()
      await db.prepare('DELETE FROM notify_channels').run()
      const r0 = await rev()
      await put(await admin(), hub, { channelIds: ['C0TEST0002'], ifRev: r0 })
      const stale = await put(await admin(), hub, { channelIds: ['C0TEST0001'], alertsChannelId: 'C0TEST0001', ifRev: r0 })
      expect(stale.status).toBe(409)
      expect(await grants()).toEqual([])
    })
  })
})
