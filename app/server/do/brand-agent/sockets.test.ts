// The chat socket and its authority (p3-design 4.2.5, 4.10; p3-w1.md "Socket expiry") on the BrandAgent's real SQLite,
// the real turn engine and scheduler, fake sockets and a fake clock. Expected values are literals written here (frame
// lines, close codes, lease ends from the design's numbers), or the test's own count of what it sent; nothing is read
// from sockets.ts. Ways it can fail, written down first:
//  1. the upgrade: a sign-in past `expMs` gets a socket; a window of 0 replays anything; a version this build doesn't
//     speak gets frames; a lease longer than min(expMs, grant end, 60 min), or the smoke member's past 15 minutes;
//  2. an attach: another person's run (an Admin's too) or an unknown one sends a frame; Inhouse gets a frame before its
//     `support.attach` line, or with the line failing; a grant ending between the upgrade and the attach, or during
//     the line's await, lets a frame out;
//  3. order: a socket sees a seq twice or out of order within one attach, misses one after a full re-attach, or gets a
//     live frame while its replay is still paging; two tabs on one run see different streams;
//  4. revocation: a removed member's socket stays open, or another member's closes; a lost `onMemberRemoved` or
//     `onGrantEnded` is never repaired; a lease runs out with no traffic and the socket stays open; a frame goes out
//     after the lease ended; a re-invited member stays refused forever;
//  5. a run token checks out on a chat other than its turn's.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { MEMBER, MIN, OTHER, SEC, T0, deferred, ev, inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { Harness } from '../../testing/brand-agent/core-harness.ts'
import type { SocketPrincipal } from './sockets.ts'
import type { SendTurnResult } from '../../../shared/contract/runs.ts'
import type { Refusal } from './ports.ts'
import { hashRunToken } from './tokens.ts'
import type { FakeSocket } from './testing/fake-socket.ts'
import { runAuthoritySweep } from './authority.ts'

const HOUR = 60 * MIN
const owner: SocketPrincipal = { kind: 'person', memberId: MEMBER, role: 'member', grantId: null, grantEndsAtMs: null, expMs: T0 + 2 * HOUR, requestId: 'req-owner' }
const other: SocketPrincipal = { ...owner, memberId: OTHER, requestId: 'req-other' }
const admin: SocketPrincipal = { ...owner, memberId: 'm_admin', role: 'admin', requestId: 'req-admin' }
const inhouse: SocketPrincipal = { kind: 'inhouse', memberId: 'm_inhouse', role: null, grantId: 'g_live', grantEndsAtMs: T0 + 20 * MIN, expMs: T0 + 2 * HOUR, requestId: 'req-inh' }
const smoke: SocketPrincipal = { kind: 'smoke', memberId: 'm_smoke', role: null, grantId: null, grantEndsAtMs: null, expMs: null, requestId: 'req-smoke' }

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
/** A live run of `MEMBER` in chat c1 with seqs 1-3 stored: run.started, turn.queued, turn.started. */
async function liveRun(h: Harness, chat = 'c1', key = 'key-sock1') {
  const a = ok(await h.submit(chat, key))
  await settle()
  h.push(a.turnId, ev.started())
  return a
}
const accepted = (h: Harness, p: SocketPrincipal): FakeSocket => {
  const { ws, answer } = h.connect(p)
  if (!ws) throw new Error(`not accepted: ${JSON.stringify(answer)}`)
  return ws
}
const attach = (h: Harness, ws: FakeSocket, runId: string, fromSeq = 0) => h.say(ws, { type: 'attach', runId, fromSeq })

describe('the upgrade (4.10, socket expiry)', () => {
  it('a sign-in past its end is refused; a window of 0 closes 4401 at once', () => inAgent(async h => {
    expect(h.connect({ ...owner, expMs: T0 - 1 }).answer).toEqual({ refuse: 'unauthorized' })
    expect(h.connect({ ...owner, expMs: T0 }).answer).toEqual({ close: 4401, reason: 'reauth' })
    expect(h.sockets).toEqual([])
  }))

  it('a version this build does not speak, or none, closes 4409', () => inAgent(async h => {
    for (const v of ['2', '0', 'one', '', null]) expect(h.connect(owner, v).answer, String(v)).toEqual({ close: 4409, reason: 'version' })
  }))

  it('a missing or malformed principal is refused', () => inAgent(async h => {
    expect(h.hub.open(null, '1')).toEqual({ refuse: 'unauthorized' })
    expect(h.hub.open('{not json', '1')).toEqual({ refuse: 'unauthorized' })
    // An Inhouse principal without a grant, a person without an expiry, a smoke member with one.
    expect(h.hub.open(JSON.stringify({ ...inhouse, grantId: null }), '1')).toEqual({ refuse: 'unauthorized' })
    expect(h.hub.open(JSON.stringify({ ...owner, expMs: null }), '1')).toEqual({ refuse: 'unauthorized' })
    expect(h.hub.open(JSON.stringify({ ...smoke, expMs: T0 + HOUR }), '1')).toEqual({ refuse: 'unauthorized' })
    expect(h.hub.open(JSON.stringify({ ...owner, extra: 1 }), '1')).toEqual({ refuse: 'unauthorized' })
  }))

  it('leases: min(expMs, grant end, now + 60 min); the smoke member 15 minutes', () => inAgent(async h => {
    const lease = (p: SocketPrincipal) => {
      const a = h.connect(p).answer
      return 'accept' in a ? { lease: a.accept.leaseEndsMs - T0, tags: a.tags } : a
    }
    expect(lease(owner)).toEqual({ lease: 60 * MIN, tags: [`m:${MEMBER}`] })
    expect(lease({ ...owner, expMs: T0 + 10 * MIN })).toEqual({ lease: 10 * MIN, tags: [`m:${MEMBER}`] })
    expect(lease(inhouse)).toEqual({ lease: 20 * MIN, tags: ['m:m_inhouse', 'g:g_live'] })
    expect(lease(smoke)).toEqual({ lease: 15 * MIN, tags: ['m:m_smoke'] })
  }))

  it('a removed member or an ended grant is closed at the upgrade', () => inAgent(async h => {
    h.core.onMemberRemoved(OTHER)
    h.core.onGrantEnded('g_live')
    expect(h.connect(other).answer).toEqual({ close: 4401, reason: 'reauth' })
    expect(h.connect(inhouse).answer).toEqual({ close: 4403, reason: 'grant_ended' })
  }))
})

describe('attach (4.2.5, 4.10)', () => {
  it('the owner gets the stored frames after fromSeq, then attached; then live frames', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, owner)
    await attach(h, ws, a.runId)
    expect(ws.take()).toEqual(['frame 1 run.started', 'frame 2 turn.queued', 'frame 3 turn.started', 'attached 3 live'])
    h.push(a.turnId, ev.text('hello'))
    expect(ws.take()).toEqual(['frame 4 part'])
    await attach(h, ws, a.runId, 2)
    expect(ws.take()).toEqual(['frame 3 turn.started', 'frame 4 part', 'attached 4 live'])
    // The frame is the design's envelope.
    await attach(h, ws, a.runId, 3)
    expect(ws.out[0]).toEqual({ type: 'frame', frame: expect.objectContaining({ v: 1, chatId: 'c1', runId: a.runId, seq: 4, at: { iso: new Date(T0).toISOString(), ms: T0 } }) })
  }))

  it('another person\'s run, an Admin\'s view of it and an unknown run are all not_found, with no frame', () => inAgent(async h => {
    const a = await liveRun(h)
    for (const p of [other, admin]) {
      const ws = accepted(h, p)
      await attach(h, ws, a.runId)
      await attach(h, ws, 'r_AAAAAAAAAAAAAAAAAAAAAA')
      expect(ws.take(), p.memberId).toEqual(['refused not_found', 'refused not_found'])
      h.push(a.turnId, ev.text('still private'))
      expect(ws.take(), p.memberId).toEqual([])
    }
  }))

  it('detach stops the frames of that run', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, owner)
    await attach(h, ws, a.runId, 3)
    expect(ws.take()).toEqual(['attached 3 live'])
    await h.say(ws, { type: 'detach', runId: a.runId })
    h.push(a.turnId, ev.text('unseen'))
    expect(ws.take()).toEqual([])
  }))

  it('a message that is not the contract changes nothing', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, owner)
    const quiet = { warn: console.warn }
    console.warn = () => {}
    try {
      await h.hub.message(ws, 'not json')
      await h.say(ws, { type: 'attach', runId: a.runId, fromSeq: -1 })
      await h.say(ws, { type: 'subscribe', runId: a.runId })
    } finally {
      console.warn = quiet.warn
    }
    expect(ws.take()).toEqual([])
    expect(ws.closed).toBeNull()
  }))

  it('a socket follows at most 100 runs (its cursors fit the 16 KB attachment)', () => inAgent(async h => {
    const ws = accepted(h, owner)
    const runs: string[] = []
    for (let i = 0; i < 101; i++) {
      const id = `r_${String(i).padStart(22, 'A')}`
      h.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms) VALUES (?, ?, ?, 'ended', 0, ?)", id, `c${i}`, MEMBER, T0)
      runs.push(id)
    }
    for (const id of runs) await attach(h, ws, id)
    const lines = ws.take()
    expect(lines.filter(l => l === 'attached 0 ended')).toHaveLength(100)
    expect(lines.at(-1)).toBe('refused rate_limited')
  }))

  it('Inhouse: the support.attach line before any frame; no line, no data', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, inhouse)
    const gate = deferred()
    h.attachAudit.gate = gate.promise
    const pending = attach(h, ws, a.runId)
    await settle()
    expect(h.attachAudit.lines).toEqual([a.runId])
    expect(ws.take(), 'nothing before the line is written').toEqual([])
    gate.resolve()
    await pending
    expect(ws.take()).toEqual(['frame 1 run.started', 'frame 2 turn.queued', 'frame 3 turn.started', 'attached 3 live'])
    h.attachAudit.gate = null
    h.attachAudit.fails = true
    const ws2 = accepted(h, inhouse)
    const quiet = console.error
    console.error = () => {}
    try {
      await attach(h, ws2, a.runId)
    } finally {
      console.error = quiet
    }
    expect(ws2.take()).toEqual(['refused unavailable'])
    h.push(a.turnId, ev.text('after the failed line'))
    expect(ws2.take(), 'a refused attach follows nothing').toEqual([])
  }))

  it('a grant ending between the upgrade and the attach closes 4403 with no frame', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, inhouse)
    // onGrantEnded closes it at once; an attach that still arrives (the close crossing it) sends nothing.
    h.core.onGrantEnded('g_live')
    expect(ws.closed).toEqual({ code: 4403, reason: 'grant_ended' })
    await attach(h, ws, a.runId)
    expect(ws.out).toEqual([])
    expect(h.attachAudit.lines).toEqual([])
  }))

  it('a grant ending during the support.attach await closes 4403 with no frame', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, inhouse)
    const gate = deferred()
    h.attachAudit.gate = gate.promise
    const pending = attach(h, ws, a.runId)
    await settle()
    // The grant's own end passes while the line is written (no call, only the clock).
    h.clock.now = T0 + 20 * MIN
    gate.resolve()
    await pending
    expect(ws.out).toEqual([])
    expect(ws.closed).toEqual({ code: 4403, reason: 'grant_ended' })
  }))

  it('an attach after expMs (refused on attach as on upgrade) closes 4401 with no frame', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, { ...owner, expMs: T0 + 10 * SEC })
    h.clock.now = T0 + 11 * SEC
    await attach(h, ws, a.runId)
    expect(ws.out).toEqual([])
    expect(ws.closed).toEqual({ code: 4401, reason: 'reauth' })
  }))
})

describe('order (4.2.5)', () => {
  it('two tabs sending into one chat both see every seq once, in order', () => inAgent(async h => {
    const a = await liveRun(h)
    const t1 = accepted(h, owner)
    const t2 = accepted(h, owner)
    await attach(h, t1, a.runId)
    await attach(h, t2, a.runId, 2)
    const b = ok(await h.submit('c1', 'key-tab2'))
    const c = ok(await h.submit('c1', 'key-tab1'))
    expect([b.runId, c.runId]).toEqual([a.runId, a.runId])
    h.push(a.turnId, ev.text('one'), ev.text('two'))
    expect(t1.seqs()).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(t2.seqs()).toEqual([3, 4, 5, 6, 7])
    expect(t1.lines().slice(4)).toEqual(['frame 4 turn.queued', 'frame 5 turn.queued', 'frame 6 part', 'frame 7 part'])
  }))

  it('a long replay pages by re-attach, and live frames wait for the socket to catch up', () => inAgent(async h => {
    const a = await liveRun(h)
    for (let i = 0; i < 7; i++) h.push(a.turnId, ev.text(`p${i}`))
    // Seqs 1-10 are stored; bursts of 4.
    const ws = accepted(h, owner)
    await attach(h, ws, a.runId)
    expect(ws.take()).toEqual(['frame 1 run.started', 'frame 2 turn.queued', 'frame 3 turn.started', 'frame 4 part', 'attached 10 live'])
    // A live event while the socket is at 4: it catches up from the store by its cursor (one burst), not the live one.
    h.push(a.turnId, ev.text('live'))
    expect(ws.seqs()).toEqual([5, 6, 7, 8])
    ws.take()
    // The client re-attaches from its last contiguous seq, as `attached.lastSeq` (10) is ahead of it.
    await attach(h, ws, a.runId, 8)
    expect(ws.take()).toEqual(['frame 9 part', 'frame 10 part', 'frame 11 part', 'attached 11 live'])
    h.push(a.turnId, ev.text('caught up'))
    expect(ws.take()).toEqual(['frame 12 part'])
  }, { burst: 4 }))

  // A tab that reconnects at any point of the replay-to-live handoff, while events keep coming (W7's socket spec at
  // unit level). The client is W5's rule: take seq c+1, drop seq <= c, attach again from c when `attached.lastSeq` > c
  // or after a reconnect. The oracle is the test's own count of events, never the hub's numbers.
  const op = fc.oneof(
    fc.record({ kind: fc.constant('event' as const), n: fc.integer({ min: 1, max: 3 }) }),
    fc.record({ kind: fc.constant('reconnect' as const) }),
    fc.record({ kind: fc.constant('reattach' as const) }),
    fc.record({ kind: fc.constant('inhouse' as const), events: fc.integer({ min: 0, max: 3 }) }),
  )
  test.prop([fc.array(op, { minLength: 1, maxLength: 25 }), fc.integer({ min: 1, max: 5 })], { numRuns: 30 })(
    'every seq once and in order per attach, and all of them in the end',
    (ops, burst) => inAgent(async h => {
      const a = await liveRun(h)
      let expected = 3
      // Each tab: its socket, its contiguous seq, and the frames of its current attach.
      const tab = (p: SocketPrincipal) => ({ p, ws: accepted(h, p), c: 0, epoch: [] as number[], lastSeq: 0 })
      const tabs = [tab(owner), tab(inhouse)]
      const read = (t: ReturnType<typeof tab>) => {
        for (const m of t.ws.out.splice(0)) {
          if (m.type === 'frame') {
            t.epoch.push(m.frame.seq)
            if (m.frame.seq === t.c + 1) t.c++
            else expect(m.frame.seq, 'no gap inside an attach').toBeLessThanOrEqual(t.c)
          } else if (m.type === 'attached') t.lastSeq = m.lastSeq
          else throw new Error(`refused ${m.code}`)
        }
      }
      const attachTab = async (t: ReturnType<typeof tab>) => {
        const from = t.c
        t.epoch = []
        await attach(h, t.ws, a.runId, from)
        read(t)
        // Within one attach, the frames are from+1, from+2, ... with nothing skipped or repeated.
        expect(t.epoch).toEqual(t.epoch.map((_, i) => from + 1 + i))
      }
      for (const t of tabs) await attachTab(t)
      for (const o of ops) {
        if (o.kind === 'event') {
          for (let i = 0; i < o.n; i++) h.push(a.turnId, ev.text(`e${expected}`))
          expected += o.n
          tabs.forEach(read)
        } else if (o.kind === 'reconnect') {
          tabs[0].ws.gone = true
          tabs[0].ws = accepted(h, owner)
          await attachTab(tabs[0])
        } else if (o.kind === 'reattach') {
          await attachTab(tabs[0])
        } else {
          // The Inhouse tab attaches again while events land during its support.attach line.
          const gate = deferred()
          h.attachAudit.gate = gate.promise
          const from = tabs[1].c
          tabs[1].epoch = []
          const pending = attach(h, tabs[1].ws, a.runId, from)
          await settle()
          for (let i = 0; i < o.events; i++) h.push(a.turnId, ev.text(`i${expected + i}`))
          expected += o.events
          tabs.forEach(read)
          // Frames of its earlier attach may have arrived during the await; the new attach's own frames start here.
          tabs[1].epoch = []
          gate.resolve()
          h.attachAudit.gate = null
          await pending
          read(tabs[1])
          expect(tabs[1].epoch).toEqual(tabs[1].epoch.map((_, i) => from + 1 + i))
        }
      }
      // The client's own rule: attach again while the server says it holds more.
      for (const t of tabs) {
        for (let i = 0; i < 100 && (t.lastSeq > t.c || t.c < expected); i++) await attachTab(t)
        expect(t.c, 'every event reached the tab').toBe(expected)
      }
    }, { burst }),
  )
})

describe('revocation (4.10)', () => {
  it('removal closes that member\'s sockets 4401 and fences their turns; another member\'s socket stays', () => inAgent(async h => {
    const a = await liveRun(h)
    const mine = [accepted(h, owner), accepted(h, owner)]
    const theirs = accepted(h, other)
    await attach(h, mine[0], a.runId)
    mine[0].take()
    h.core.onMemberRemoved(MEMBER)
    expect(mine.map(w => w.closed)).toEqual([{ code: 4401, reason: 'reauth' }, { code: 4401, reason: 'reauth' }])
    expect(theirs.closed).toBeNull()
    expect(h.turn(a.turnId).fenced).toBe(1)
    // The fence's events go to no closed socket.
    expect(mine[0].out).toEqual([])
  }))

  it('a frame due after the lease ended is not sent: the socket closes 4401 instead', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, owner)
    await attach(h, ws, a.runId, 3)
    ws.take()
    h.clock.now = T0 + 60 * MIN
    h.push(a.turnId, ev.text('too late'))
    expect(ws.out).toEqual([])
    expect(ws.closed).toEqual({ code: 4401, reason: 'reauth' })
  }))

  it('the smoke member\'s socket closes 4401 at 15 minutes with no traffic (the sweep wakes at the lease end)', () => inAgent(async h => {
    const ws = accepted(h, smoke)
    await h.tick(15 * MIN - 1)
    expect(ws.closed).toBeNull()
    await h.tick(1)
    expect(ws.closed).toEqual({ code: 4401, reason: 'reauth' })
  }))

  it('an Inhouse socket closes 4403 at its grant\'s end, with no call and no traffic', () => inAgent(async h => {
    const ws = accepted(h, inhouse)
    await h.tick(20 * MIN - 1)
    expect(ws.closed).toBeNull()
    await h.tick(1)
    expect(ws.closed).toEqual({ code: 4403, reason: 'grant_ended' })
  }))
})

describe('the authority sweep and grant expiry (4.10, D1)', () => {
  const db = env.DB
  const member = async (id: string, status: 'active' | 'removed', removedAt: number | null) => {
    await db.prepare("INSERT OR REPLACE INTO members (id, kind, role, status, name, email_norm, subject, rev, created_at_ms, removed_at_ms) VALUES (?, 'person', 'member', ?, 'Test', ?, ?, 1, 0, ?)")
      .bind(id, status, `${id}@example.test`, `sub-${id}`, removedAt).run()
  }
  const grant = async (id: string, endsAt: number, endedAt: number | null) => {
    await db.prepare('INSERT OR REPLACE INTO support_grants (id, created_by, created_at_ms, ends_at_ms, ended_at_ms) VALUES (?, ?, ?, ?, ?)')
      .bind(id, 'm_admin', T0 - HOUR, endsAt, endedAt).run()
  }
  const inSet = (h: Harness, kind: string) => h.sql.exec<{ id: string }>('SELECT id FROM authority WHERE kind = ? ORDER BY id', kind).toArray().map(r => r.id)
  const sweepDue = (h: Harness) => h.dueTasks().find(t => t.id === 'authority-sweep')?.due_at_ms ?? null

  it('a lost onMemberRemoved is repaired by the sweep: the socket closes 4401, the turn is fenced', () => inAgent(async h => {
    const id = `m_lost${Math.random().toString(36).slice(2, 8)}`
    const p: SocketPrincipal = { ...owner, memberId: id }
    const a = ok(await h.submit('c1', 'key-lost1', { member: id }))
    await settle()
    const ws = accepted(h, p)
    await member(id, 'removed', T0 + SEC)
    // The sweep runs every 5 minutes while a socket or a turn exists.
    expect(sweepDue(h)).toBe(T0 + 5 * MIN)
    await h.tick(5 * MIN)
    expect(ws.closed).toEqual({ code: 4401, reason: 'reauth' })
    expect(inSet(h, 'member')).toContain(id)
    expect(h.turn(a.turnId).fenced).toBe(1)
  }))

  it('a lost onGrantEnded is repaired by the sweep: the Inhouse socket closes 4403', () => inAgent(async h => {
    const g = `g_lost${Math.random().toString(36).slice(2, 8)}`
    await grant(g, T0 + 2 * HOUR, null)
    const ws = accepted(h, { ...inhouse, grantId: g, grantEndsAtMs: T0 + 2 * HOUR })
    await grant(g, T0 + 2 * HOUR, T0 + MIN)
    await h.tick(5 * MIN)
    expect(ws.closed).toEqual({ code: 4403, reason: 'grant_ended' })
    expect(inSet(h, 'grant')).toContain(g)
  }))

  it('the sweep seeds grant-expiry for a live grant; at its end the object ends it', () => inAgent(async h => {
    const g = `g_seed${Math.random().toString(36).slice(2, 8)}`
    await grant(g, T0 + 30 * MIN, null)
    const ws = accepted(h, { ...inhouse, grantId: g, grantEndsAtMs: T0 + 30 * MIN })
    h.core.ensureSeeds()
    await h.tick(0)
    expect(h.dueTasks().find(t => t.id === `grant-expiry:${g}`)?.due_at_ms).toBe(T0 + 30 * MIN)
    await h.tick(30 * MIN)
    expect(inSet(h, 'grant')).toContain(g)
    expect(ws.closed).toEqual({ code: 4403, reason: 'grant_ended' })
    // Done once the grant ended: never rescheduled at a past time (a hot alarm loop).
    expect(h.dueTasks().map(t => t.id)).not.toContain(`grant-expiry:${g}`)
  }))

  // P3 acceptance items 2 and 6: the grant-expiry task alone closes the socket. The grant's end in D1 (T0 + 31 min)
  // is before the end the socket was issued with (T0 + 2 h, as when a grant is shortened), so its own lease can't, and
  // T0 + 31 min falls between two 5-minute sweeps, so the sweep can't either.
  it('the grant-expiry task, fired by the clock at the grant\'s end in D1, closes the Inhouse socket 4403', () => inAgent(async h => {
    const g = `g_task${Math.random().toString(36).slice(2, 8)}`
    await grant(g, T0 + 31 * MIN, null)
    const ws = accepted(h, { ...inhouse, grantId: g, grantEndsAtMs: T0 + 2 * HOUR })
    h.core.onGrantCreated(g, T0 + 31 * MIN)
    expect(h.dueTasks().find(t => t.id === `grant-expiry:${g}`)?.due_at_ms).toBe(T0 + 31 * MIN)
    await h.tick(31 * MIN - 1)
    expect(ws.closed).toBeNull()
    expect(inSet(h, 'grant')).not.toContain(g)
    await h.tick(1)
    expect(ws.closed).toEqual({ code: 4403, reason: 'grant_ended' })
    expect(inSet(h, 'grant')).toContain(g)
    expect(h.dueTasks().map(t => t.id)).not.toContain(`grant-expiry:${g}`)
  }))

  it('onGrantCreated schedules grant-expiry at the end; an early run waits for D1\'s end', () => inAgent(async h => {
    const g = `g_made${Math.random().toString(36).slice(2, 8)}`
    await grant(g, T0 + HOUR, null)
    h.core.onGrantCreated(g, T0 + HOUR)
    expect(h.dueTasks().find(t => t.id === `grant-expiry:${g}`)?.due_at_ms).toBe(T0 + HOUR)
    // Run it early (as a reschedule could): D1 says the grant still runs, so it waits for its end.
    h.sched.schedule({ id: `grant-expiry:${g}`, kind: 'grant-expiry', dueAtMs: T0 })
    await h.tick(0)
    expect(inSet(h, 'grant')).not.toContain(g)
    expect(h.dueTasks().find(t => t.id === `grant-expiry:${g}`)?.due_at_ms).toBe(T0 + HOUR)
  }))

  it('a re-invited member leaves the removed set at the next sweep and can send again', () => inAgent(async h => {
    const id = `m_back${Math.random().toString(36).slice(2, 8)}`
    await member(id, 'removed', T0)
    h.core.onMemberRemoved(id)
    expect(ok(await h.submit('c7', 'key-busy1')).position).toBe('starting')
    expect(await h.submit('c8', 'key-back1', { member: id })).toEqual({ refused: { code: 'forbidden', reason: 'removed' } })
    await member(id, 'active', null)
    h.clock.now += SEC
    await h.tick(5 * MIN)
    expect(inSet(h, 'member')).not.toContain(id)
    expect(ok(await h.submit('c8', 'key-back2', { member: id })).position).toBe('starting')
  }))

  it('the sweep stops once no socket and no turn is left, and a new socket wakes it', () => inAgent(async h => {
    const ws = accepted(h, owner)
    expect(sweepDue(h)).toBe(T0 + 5 * MIN)
    ws.gone = true
    await h.tick(5 * MIN)
    expect(sweepDue(h)).toBeNull()
    accepted(h, smoke)
    expect(sweepDue(h)).toBe(T0 + 10 * MIN)
  }))
})

describe('run tokens stay on their own chat', () => {
  it('a token checks out with its turn\'s chat and session only, whatever else is live', () => inAgent(async h => {
    const minted: string[] = []
    const mint = h.tokens.mint.bind(h.tokens)
    h.tokens.mint = async (g, now) => { const t = await mint(g, now); minted.push(t); return t }
    const a = await liveRun(h, 'chat-a', 'key-tok-a')
    const b = await liveRun(h, 'chat-b', 'key-tok-b')
    expect(minted).toHaveLength(2)
    const grantA = h.core.checkRunToken(await hashRunToken(minted[0]), 'store')
    const grantB = h.core.checkRunToken(await hashRunToken(minted[1]), 'files')
    expect(grantA).toMatchObject({ chatId: 'chat-a', turnId: a.turnId, sessionId: h.turn(a.turnId).session_id })
    expect(grantB).toMatchObject({ chatId: 'chat-b', turnId: b.turnId, sessionId: h.turn(b.turnId).session_id })
    expect(h.turn(a.turnId).session_id).not.toBe(h.turn(b.turnId).session_id)
  }))
})

// Round 1 fold (#166 reviews, p3-w1-pr4-fold-r1.md). Ways it can fail, written down first:
//  1. a re-invited member stays refused when nothing else keeps the sweep running (O1/F1), also after a sweep whose
//     read predates the re-invite (interleaving B);
//  2. the sweep takes a member out of the removed set although a removal landed during its read (O2/F2), or misses a
//     removal committed between two sweeps' reads (F3);
//  3. an Inhouse detach during the support.attach await is undone by the attach (O3); concurrent Inhouse attaches pass
//     the per-socket bound;
//  4. a quarantined sweep never comes back, or a D1 outage keeps an idle expired socket open (O4/F5);
//  5. a cursor is set past the run's last seq and later events never go out (F7).
describe('round 1 fold', () => {
  const db = env.DB
  const member = async (id: string, status: 'active' | 'removed', removedAt: number | null) => {
    await db.prepare("INSERT OR REPLACE INTO members (id, kind, role, status, name, email_norm, subject, rev, created_at_ms, removed_at_ms) VALUES (?, 'person', 'member', ?, 'Test', ?, ?, 1, 0, ?)")
      .bind(id, status, `${id}@example.test`, `sub-${id}`, removedAt).run()
  }
  const inSet = (h: Harness) => h.sql.exec<{ id: string }>("SELECT id FROM authority WHERE kind = 'member'").toArray().map(r => r.id)
  const sweepTask = (h: Harness) => h.sql.exec<{ due_at_ms: number; state: string }>("SELECT due_at_ms, state FROM due_tasks WHERE id = 'authority-sweep'").toArray()[0] ?? null
  const rid = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}`
  const deps = (h: Harness, d: D1Database = db) => ({
    sql: h.sql, db: d, scheduler: h.sched, now: () => h.clock.now, sockets: h.hub,
    onMemberRemoved: (id: string) => h.core.onMemberRemoved(id), onGrantEnded: (id: string) => h.core.onGrantEnded(id),
  })
  /** The sweep with its D1 batch held after the read ran (the read is taken; the writes wait). */
  const gatedSweep = (h: Harness) => {
    const gate = deferred()
    const read = deferred()
    const gdb = { prepare: (q: string) => db.prepare(q), batch: async (b: D1PreparedStatement[]) => { const r = await db.batch(b); read.resolve(); await gate.promise; return r } } as unknown as D1Database
    const run = runAuthoritySweep(deps(h, gdb))
    return { read: read.promise, release: () => gate.resolve(), run }
  }

  it('a re-invited member with nothing else open: the refused send runs the sweep at once, then they are admitted', () => inAgent(async h => {
    const id = rid('m_ri')
    await member(id, 'removed', T0)
    h.core.onMemberRemoved(id)
    await member(id, 'active', null)
    h.clock.now += SEC
    expect(sweepTask(h)).toBeNull()
    expect(await h.submit('c_ri', 'key-ri01', { member: id })).toEqual({ refused: { code: 'forbidden', reason: 'removed' } })
    expect(sweepTask(h)).toEqual({ due_at_ms: T0 + SEC, state: 'ready' })
    await h.tick(0)
    expect(inSet(h)).not.toContain(id)
    expect(ok(await h.submit('c_ri', 'key-ri02', { member: id })).position).toBe('starting')
  }))

  it('a re-invited member with nothing else open: the refused upgrade runs the sweep at once, then it is accepted', () => inAgent(async h => {
    const id = rid('m_ru')
    await member(id, 'removed', T0)
    h.core.onMemberRemoved(id)
    await member(id, 'active', null)
    h.clock.now += SEC
    const p = { ...owner, memberId: id }
    expect(h.connect(p).answer).toEqual({ close: 4401, reason: 'reauth' })
    expect(sweepTask(h)).toEqual({ due_at_ms: T0 + SEC, state: 'ready' })
    await h.tick(0)
    expect(h.connect(p).ws).not.toBeNull()
  }))

  it('interleaving B: removal (call lost), sweep read, re-invite, sweep write: the next refusal repairs it', () => inAgent(async h => {
    const id = rid('m_b')
    await member(id, 'removed', T0)
    const g = gatedSweep(h)
    await g.read
    await member(id, 'active', null)
    h.clock.now += SEC
    g.release()
    await g.run
    expect(inSet(h), 'the stale read put them in').toContain(id)
    expect(sweepTask(h), 'nothing open: no sweep comes back by itself').toBeNull()
    h.clock.now += SEC
    expect(await h.submit('c_b', 'key-b0001', { member: id })).toEqual({ refused: { code: 'forbidden', reason: 'removed' } })
    await h.tick(0)
    expect(inSet(h)).not.toContain(id)
    expect(ok(await h.submit('c_b', 'key-b0002', { member: id })).position).toBe('starting')
  }))

  for (const advance of [0, SEC]) {
    it(`interleaving C: re-invited, sweep read, removed again with its call (clock +${advance}), sweep write: stays removed`, () => inAgent(async h => {
      const id = rid('m_c')
      await member(id, 'removed', T0 - HOUR)
      h.core.onMemberRemoved(id)
      await member(id, 'active', null)
      h.clock.now += SEC
      const g = gatedSweep(h)
      await g.read
      h.clock.now += advance
      await member(id, 'removed', h.clock.now)
      h.core.onMemberRemoved(id)
      g.release()
      await g.run
      expect(inSet(h)).toContain(id)
    }))
  }

  it('a removal committed while one sweep read is seen by the next sweep (the read overlaps its cursor)', () => inAgent(async h => {
    const id = rid('m_ov')
    h.clock.now += HOUR
    const g = gatedSweep(h)
    await g.read
    // Stamped just before the first read, committed after it.
    await member(id, 'removed', h.clock.now - SEC)
    g.release()
    await g.run
    expect(inSet(h)).not.toContain(id)
    h.clock.now += 5 * MIN
    await runAuthoritySweep(deps(h))
    expect(inSet(h)).toContain(id)
  }))

  it('an Inhouse detach during the support.attach await: nothing is attached, no frame follows', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, inhouse)
    const gate = deferred()
    h.attachAudit.gate = gate.promise
    const pending = attach(h, ws, a.runId, 3)
    await settle()
    await h.say(ws, { type: 'detach', runId: a.runId })
    gate.resolve()
    await pending
    expect(ws.take()).toEqual([])
    h.push(a.turnId, ev.text('after detach'))
    expect(ws.take()).toEqual([])
  }))

  it('Inhouse attaches waiting on their line count toward the 100 runs', () => inAgent(async h => {
    const ws = accepted(h, inhouse)
    const ids: string[] = []
    for (let i = 0; i < 101; i++) {
      const id = `r_${String(i).padStart(22, 'B')}`
      h.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms) VALUES (?, ?, ?, 'ended', 0, ?)", id, `c${i}`, MEMBER, T0)
      ids.push(id)
    }
    const gate = deferred()
    h.attachAudit.gate = gate.promise
    const pending = ids.map(id => attach(h, ws, id))
    await settle()
    gate.resolve()
    await Promise.all(pending)
    const lines = ws.take()
    expect(lines.filter(l => l === 'attached 0 ended')).toHaveLength(100)
    expect(lines.filter(l => l === 'refused rate_limited')).toHaveLength(1)
    expect(h.attachAudit.lines, 'no support.attach line for an attach the socket can\'t hold').toHaveLength(100)
  }))

  it('a quarantined sweep is revived by the next send and by the next socket', () => inAgent(async h => {
    const quarantine = () => h.sql.exec("INSERT OR REPLACE INTO due_tasks (id, kind, gen, due_at_ms, attempts, state) VALUES ('authority-sweep', 'authority-sweep', 7, ?, 10, 'quarantined')", T0)
    quarantine()
    ok(await h.submit('c_q', 'key-q0001'))
    expect(sweepTask(h)).toEqual({ due_at_ms: T0 + 5 * MIN, state: 'ready' })
    quarantine()
    accepted(h, smoke)
    expect(sweepTask(h)).toEqual({ due_at_ms: T0 + 5 * MIN, state: 'ready' })
  }))

  it('D1 failing: the sweep still closes an idle socket whose lease ended', () => inAgent(async h => {
    const ws = accepted(h, { ...owner, expMs: T0 + 2 * MIN })
    h.clock.now = T0 + 2 * MIN
    const down = { prepare: (q: string) => db.prepare(q), batch: async () => { throw new Error('D1 down') } } as unknown as D1Database
    await expect(runAuthoritySweep(deps(h, down))).rejects.toThrow('D1 down')
    expect(ws.closed).toEqual({ code: 4401, reason: 'reauth' })
  }))

  it('an attach from past the run\'s last seq starts at the last seq, so the next event goes out', () => inAgent(async h => {
    const a = await liveRun(h)
    const ws = accepted(h, owner)
    await attach(h, ws, a.runId, 99)
    expect(ws.take()).toEqual(['attached 3 live'])
    h.push(a.turnId, ev.text('next'))
    expect(ws.take()).toEqual(['frame 4 part'])
  }))

  // #166 round 2 (N1): a pending mark an attach leaves behind holds one of the socket's 100 slots for good.
  it('a failed support.attach releases its slot: 100 more runs fit afterwards', () => inAgent(async h => {
    const ws = accepted(h, inhouse)
    const runs = (n: number, pad: string) => Array.from({ length: n }, (_, i) => {
      const id = `r_${String(i).padStart(22, pad)}`
      h.sql.exec("INSERT INTO runs (run_id, chat_id, owner_id, state, last_seq, started_at_ms) VALUES (?, ?, ?, 'ended', 0, ?)", id, `c${pad}${i}`, MEMBER, T0)
      return id
    })
    const [failing] = runs(1, 'X')
    h.attachAudit.fails = true
    const quiet = console.error
    console.error = () => {}
    try {
      await attach(h, ws, failing)
    } finally {
      console.error = quiet
    }
    expect(ws.take()).toEqual(['refused unavailable'])
    expect((ws.deserializeAttachment() as { pending?: Record<string, number> }).pending ?? {}).toEqual({})
    h.attachAudit.fails = false
    for (const id of runs(100, 'Y')) await attach(h, ws, id)
    const lines = ws.take()
    expect(lines.filter(l => l === 'attached 0 ended')).toHaveLength(100)
    expect(lines.filter(l => l.startsWith('refused'))).toEqual([])
  }))
})
