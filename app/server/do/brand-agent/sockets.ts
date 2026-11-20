// The BrandAgent's chat sockets (p3-design 4.2.5 and 4.10): route 34's upgrade lands here with the principal route 34
// verified, and the object holds the socket through the hibernation API. Plain code over injected parts (the object's
// SQLite, a clock, the sockets, the audit write), so tests drive it with fake sockets on a fake clock.
//
// The rules (4.10):
// - Each socket's attachment holds its principal, its lease end and a per-run cursor (`runs[runId]` = the last seq sent),
//   never frames (an attachment is at most 16,384 bytes, docs). `leaseEndsMs = min(expMs, grantEndsAtMs, now + 60 min)`;
//   the smoke member has no `expMs`, so its lease is `min(grant, now + 15 min)` (p3-w1.md, socket expiry).
// - Authority is checked synchronously at the upgrade, at every attach and before every frame: the lease, the removed
//   set, the ended-grant set. A grant that ended (by hand, by the sweep or by its own end time) closes `4403`; a removed
//   member or a lease that ran out closes `4401`. A principal whose `expMs` has passed is refused the upgrade (401); one
//   whose window is 0 is closed `4401` at once, before any replay.
// - An attach is one synchronous step: the cursor is set to `fromSeq`, up to 500 stored events after it go out, then
//   `attached { lastSeq, live }`. A client whose last contiguous seq is still below `lastSeq` attaches again from it
//   (W5's `RunFeed.reattachFrom()`), which pages a long replay without a buffer on the server.
// - A live event goes straight to a socket only when its cursor is `seq - 1`; a socket behind catches up from `events`
//   by its cursor (up to 500), so every socket sees seqs strictly in order and never the same one twice per attach.
// - An Inhouse attach writes its `support.attach` line (awaited D1) before any of its frames: no line, no data. The
//   attach is decided again after that await (the socket, its authority and its cursor as they are then).
// https://developers.cloudflare.com/durable-objects/best-practices/websockets/ and /api/state/ (read 2026-11-20).
import { z } from 'zod'
import { CHAT_PROTOCOL_VERSION, SocketClientMsgSchema, acceptsChatVersion } from '../../../shared/contract/runs.ts'
import type { ChatEvent, ChatFrameEnvelope, SocketServerMsg } from '../../../shared/contract/runs.ts'
import type { AgentErrorCode } from '../../../shared/contract/common.ts'

/** The header route 34 sets (after deleting any incoming copy) with the principal it verified. */
export const PRINCIPAL_HEADER = 'x-inhouse-principal'
/** A socket's lease is at most this long (CHOICE, 4.10: bounds any missed revocation). */
export const LEASE_MAX_MS = 60 * 60_000
/** The smoke member's socket lease (it carries no `expMs`; p3-w1.md, socket expiry). */
export const SMOKE_LEASE_MS = 15 * 60_000
/** Stored events sent per burst (4.2.5). */
export const REPLAY_BURST = 500
/** Runs one socket may follow at once: each costs its cursor in the 16 KB attachment. */
export const MAX_RUNS_PER_SOCKET = 100
/** The serialized attachment's limit (docs, "Maximum serialized size is 16,384 bytes"). */
export const ATTACHMENT_MAX_BYTES = 16_384

/** The close codes (4.10; the client's table is `app/src/agent/http/stream/close.ts`). */
export const CLOSE_REAUTH = 4401
export const CLOSE_GRANT_ENDED = 4403
export const CLOSE_VERSION = 4409

/** What route 34 tells the object about the caller (4.10), plus the request id an Inhouse attach line carries. */
export const SocketPrincipalSchema = z.object({
  kind: z.enum(['person', 'inhouse', 'smoke']),
  memberId: z.string().min(1),
  role: z.enum(['member', 'admin']).nullable(),
  grantId: z.string().min(1).nullable(),
  grantEndsAtMs: z.number().int().nullable(),
  expMs: z.number().int().nullable(),
  requestId: z.string().min(1),
}).strict()
  // A person has a role and an expiry, an Inhouse member a grant and an expiry, the smoke member neither.
  .refine(p => p.kind === 'person' ? p.role !== null && p.expMs !== null && p.grantId === null
    : p.kind === 'inhouse' ? p.role === null && p.expMs !== null && p.grantId !== null && p.grantEndsAtMs !== null
      : p.role === null && p.expMs === null && p.grantId === null && p.grantEndsAtMs === null)
export type SocketPrincipal = z.infer<typeof SocketPrincipalSchema>

/** A socket's attachment: who, until when, and the last seq sent per followed run. */
export interface SocketAttachment {
  p: SocketPrincipal
  leaseEndsMs: number
  runs: Record<string, number>
  /** Set when the object closed it (a closing socket can still be listed for a while, docs). */
  closed?: true
}

/** The part of a WebSocket the hub uses (the runtime's hibernatable WebSocket has all of it). */
export interface HubSocket {
  send(message: string): void
  close(code?: number, reason?: string): void
  serializeAttachment(value: unknown): void
  deserializeAttachment(): unknown
}

export interface HubParts {
  sql: SqlStorage
  now: () => number
  /** Every socket the object holds (`ctx.getWebSockets()`). */
  sockets: () => HubSocket[]
  /** Writes the `support.attach { grantId, runId }` line (awaited D1); throws when it can't. */
  auditAttach: (p: SocketPrincipal, runId: string) => Promise<void>
  /** A socket's authority must be checked again by `atMs` (its lease end): the authority sweep runs by then. */
  wakeBy: (atMs: number) => void
  /** Events per replay burst (tests pass a small one). */
  burst?: number
}

/** The upgrade's answer: refused before any socket, closed at once with a code, or accepted. */
export type OpenAnswer =
  | { refuse: 'unauthorized' }
  | { close: number; reason: string }
  | { accept: SocketAttachment; tags: string[] }

/** A stored chat event as `onEvent` gets it (core.ts's `emit`). */
export interface StoredEvent { runId: string; seq: number; atMs: number; chatId: string; event: ChatEvent }

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

export class SocketHub {
  private readonly d: HubParts
  private readonly burst: number
  constructor(parts: HubParts) {
    this.d = parts
    this.burst = parts.burst ?? REPLAY_BURST
  }

  // ---------- authority ----------

  private inSet(kind: 'member' | 'grant', id: string): boolean {
    return this.d.sql.exec('SELECT 1 FROM authority WHERE kind = ? AND id = ?', kind, id).toArray().length > 0
  }

  /** Why this socket may no longer hold data, as its close code, or null while it may. */
  verdict(att: SocketAttachment, now: number): number | null {
    const p = att.p
    if (p.grantId !== null && (this.inSet('grant', p.grantId) || (p.grantEndsAtMs !== null && now >= p.grantEndsAtMs))) return CLOSE_GRANT_ENDED
    if (this.inSet('member', p.memberId)) return CLOSE_REAUTH
    if (now >= att.leaseEndsMs) return CLOSE_REAUTH
    return null
  }

  private read(ws: HubSocket): SocketAttachment | null {
    const att = ws.deserializeAttachment() as SocketAttachment | null | undefined
    return att && typeof att === 'object' && 'p' in att ? att : null
  }

  private write(ws: HubSocket, att: SocketAttachment) {
    ws.serializeAttachment(att)
  }

  private shut(ws: HubSocket, att: SocketAttachment, code: number) {
    try {
      this.write(ws, { ...att, runs: {}, closed: true })
    } catch { /* a socket already gone keeps no attachment */ }
    try {
      ws.close(code, code === CLOSE_GRANT_ENDED ? 'grant_ended' : 'reauth')
    } catch (err) {
      console.warn({ event: 'socket_close_failed', code, error: err instanceof Error ? err.name : 'unknown' })
    }
  }

  /** Closes the socket when its authority failed; true when it may go on. */
  private stands(ws: HubSocket, att: SocketAttachment): boolean {
    const code = this.verdict(att, this.d.now())
    if (code === null) return true
    this.shut(ws, att, code)
    return false
  }

  // ---------- the upgrade ----------

  /** Route 34's upgrade: the principal header and the browser's `?v=`. */
  open(header: string | null, v: string | null): OpenAnswer {
    const now = this.d.now()
    let parsed: unknown
    try {
      parsed = header === null ? null : JSON.parse(header)
    } catch {
      parsed = null
    }
    const p = SocketPrincipalSchema.safeParse(parsed)
    if (!p.success) return { refuse: 'unauthorized' }
    // jose accepts a token up to 30 s past `exp`: a sign-in past its end is refused here (p3-w1.md, socket expiry).
    if (p.data.expMs !== null && p.data.expMs < now) return { refuse: 'unauthorized' }
    const version = v !== null && /^\d{1,6}$/.test(v) ? Number(v) : null
    if (version === null || !acceptsChatVersion(version)) return { close: CLOSE_VERSION, reason: 'version' }
    const leaseEndsMs = Math.min(
      p.data.expMs ?? now + SMOKE_LEASE_MS,
      p.data.grantEndsAtMs ?? Number.POSITIVE_INFINITY,
      now + LEASE_MAX_MS,
    )
    const att: SocketAttachment = { p: p.data, leaseEndsMs, runs: {} }
    const code = this.verdict(att, now)
    if (code !== null) return { close: code, reason: code === CLOSE_GRANT_ENDED ? 'grant_ended' : 'reauth' }
    const tags = [`m:${p.data.memberId}`]
    if (p.data.grantId !== null) tags.push(`g:${p.data.grantId}`)
    return { accept: att, tags }
  }

  /** The socket was accepted with this attachment: store it and make sure its lease end is checked. */
  accepted(ws: HubSocket, att: SocketAttachment) {
    this.write(ws, att)
    this.d.wakeBy(att.leaseEndsMs)
  }

  // ---------- messages ----------

  private send(ws: HubSocket, msg: SocketServerMsg) {
    ws.send(JSON.stringify(msg))
  }

  private frame(runId: string, chatId: string, seq: number, atMs: number, event: unknown): SocketServerMsg {
    const frame: ChatFrameEnvelope = { v: CHAT_PROTOCOL_VERSION, chatId, runId, seq, at: instant(atMs), event }
    return { type: 'frame', frame }
  }

  /** Sends up to one burst of stored events after the socket's cursor for `runId`, and moves the cursor. */
  private pump(ws: HubSocket, att: SocketAttachment, runId: string, chatId: string) {
    const from = att.runs[runId]
    const rows = this.d.sql.exec<{ seq: number; at_ms: number; json: string }>(
      'SELECT seq, at_ms, json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?', runId, from, this.burst).toArray()
    for (const r of rows) {
      this.send(ws, this.frame(runId, chatId, r.seq, r.at_ms, JSON.parse(r.json)))
      att.runs[runId] = r.seq
    }
  }

  /** A message from the browser: `attach { runId, fromSeq }` or `detach { runId }`. */
  async message(ws: HubSocket, raw: string | ArrayBuffer): Promise<void> {
    let att = this.read(ws)
    if (!att || att.closed) return
    if (!this.stands(ws, att)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      parsed = null
    }
    const msg = SocketClientMsgSchema.safeParse(parsed)
    if (!msg.success) {
      console.warn({ event: 'socket_bad_message' })
      return
    }
    const { runId } = msg.data
    if (msg.data.type === 'detach') {
      delete att.runs[runId]
      this.write(ws, att)
      return
    }
    const fromSeq = msg.data.fromSeq
    const run = this.runOf(runId)
    // Another person's run is the same answer as no run (BD11; an Admin's included). Inhouse reads any under its grant.
    if (!run || (att.p.kind !== 'inhouse' && run.owner_id !== att.p.memberId)) return this.refuse(ws, runId, 'not_found')
    if (!(runId in att.runs) && Object.keys(att.runs).length >= MAX_RUNS_PER_SOCKET) return this.refuse(ws, runId, 'rate_limited')
    if (att.p.kind === 'inhouse') {
      try {
        await this.d.auditAttach(att.p, runId)
      } catch (err) {
        console.error({ event: 'support_attach_unlogged', error: err instanceof Error ? err.name : 'unknown' })
        return this.refuse(ws, runId, 'unavailable')
      }
      // Decided again as things are after the await: the socket may be closed, its grant ended, its cursors moved.
      att = this.read(ws)
      if (!att || att.closed) return
      if (!this.stands(ws, att)) return
    }
    this.attachNow(ws, att, runId, fromSeq)
  }

  /** The attach's synchronous step (4.2.5): cursor, one burst, then `attached`. */
  private attachNow(ws: HubSocket, att: SocketAttachment, runId: string, fromSeq: number) {
    const run = this.runOf(runId)
    if (!run) return this.refuse(ws, runId, 'not_found')
    att.runs[runId] = fromSeq
    try {
      this.pump(ws, att, runId, run.chat_id)
      this.send(ws, { type: 'attached', runId, lastSeq: run.last_seq, live: run.state === 'live' })
    } finally {
      this.write(ws, att)
    }
  }

  private refuse(ws: HubSocket, runId: string, code: AgentErrorCode) {
    this.send(ws, { type: 'refused', runId, code })
  }

  private runOf(runId: string) {
    return this.d.sql.exec<{ chat_id: string; owner_id: string; state: 'live' | 'ended'; last_seq: number }>(
      'SELECT chat_id, owner_id, state, last_seq FROM runs WHERE run_id = ?', runId).toArray()[0] ?? null
  }

  // ---------- fan-out ----------

  /** A chat event was stored (core.ts's `emit`, in its synchronous step). Never throws: one bad socket stops nothing. */
  onEvent(e: StoredEvent) {
    for (const ws of this.d.sockets()) {
      try {
        const att = this.read(ws)
        if (!att || att.closed) continue
        const cursor = att.runs[e.runId]
        if (cursor === undefined) continue
        if (!this.stands(ws, att)) continue
        if (cursor === e.seq - 1) {
          this.send(ws, this.frame(e.runId, e.chatId, e.seq, e.atMs, e.event))
          att.runs[e.runId] = e.seq
        } else if (cursor < e.seq - 1) {
          // Behind (a replay still paging): catch up from `events` by the cursor, never from a buffer.
          this.pump(ws, att, e.runId, e.chatId)
        } else {
          continue
        }
        this.write(ws, att)
      } catch (err) {
        console.warn({ event: 'socket_send_failed', error: err instanceof Error ? err.name : 'unknown' })
      }
    }
  }

  // ---------- revocation ----------

  /** Closes every socket whose authority failed (a member removed, a grant ended, a lease run out). */
  sweep(): { open: number; nextLeaseEndMs: number | null } {
    let open = 0
    let next: number | null = null
    for (const ws of this.d.sockets()) {
      const att = this.read(ws)
      if (!att || att.closed) continue
      if (!this.stands(ws, att)) continue
      open++
      next = next === null ? att.leaseEndsMs : Math.min(next, att.leaseEndsMs)
    }
    return { open, nextLeaseEndMs: next }
  }

  /** How many sockets are open (not closed by the object). */
  openCount(): number {
    return this.d.sockets().filter(ws => {
      const att = this.read(ws)
      return att !== null && !att.closed
    }).length
  }

  /** `onMemberRemoved` and `onGrantEnded` (4.10): the set already holds the id, so the sweep closes their sockets. */
  closeMember(_memberId: string) { this.sweep() }
  closeGrant(_grantId: string) { this.sweep() }
}
