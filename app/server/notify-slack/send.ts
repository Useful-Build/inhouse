// Notices from the server (p5-w4.md sections 1 to 9): the agent's `notification_send` (`notifyAgent`) and the server's
// own notices (`sendSystemNotice`, P6's approver notice). Our server decides everything: it validates, resolves member
// ids (the bell) and listed channel names, runs the bounds that don't escape, reserves the caps in one statement per
// recipient, and audits one line per recipient per call.
// - Stage 1 M2-N (Wasim, Q3 = A; decision "Slack posts without a card"): the agent's post to a listed channel follows the
//   same rule as any Slack post. It is proposed through the outbox as `slack.channel.post` (the `SlackLeg` the tool
//   builds: N14's admission, then `outbox.request()`), so it goes out only under a live grant (the brand's grant an admin
//   gave by marking the channel for alerts, or a person's "Always allow") or once a person approves its card. With no
//   operation enabled in the ceiling (N2, every deployable build) it is refused and nothing is asked or sent.
// - The server's own fixed notices (an approval is waiting, a routine failed) post to the admin-marked alerts channel
//   directly, through the hub's DeliveryGateway (`HUB_DELIVERY`), whose Slack SignIn re-checks, escapes once and posts
//   with fixed parameters. Their title is a template; model text only ever in the bounded body.
// - A member id reaches the bell only: never Slack in any form. An Inhouse member, a service row or anyone not an
//   active person is `unknown_member`, so the agent is never told "sent" for a bell nobody reads.
// - Model text goes only in the bell's `body`, the hub's title and text and the outbox's action arguments; never a
//   template, `fields`, a link, a log, an audit line or a D1 table we own besides the action (`notify_sends` keeps a hash).
// - One send, no retry: a hub call that throws leaves the row `reserved` and answers `unknown: not retried`.
import type { DeliveryGateway, HubResult } from '../../hub/index/contract.ts'
import type { ActionState } from '../../shared/contract/actions.ts'
import { plainAnswer } from '../../shared/rpc-answer.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { boundBody, boundNotice, SYSTEM_BODY_MAX } from '../../shared/notify/bound.ts'
import type { BoundChanges, NoticeFormat } from '../../shared/notify/bound.ts'
import { bellLink, checkLink } from '../../shared/notify/links.ts'
import type { NoticeLinkInput } from '../../shared/notify/links.ts'
import { auditInsert } from '../db/audit.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { all, stmt, storage } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { addNotice } from '../notices/store.ts'
import { agentRow, capHit, reserveAgent, reserveSystem, settle, systemRow } from './store.ts'
import type { SendKind, SendRow, SystemSource } from './store.ts'
import { NO_BODY_TEXT, storedKind, systemTitle } from './templates.ts'
import type { StoredSystemKind, SystemNoticeKind } from './templates.ts'

/** The DeliveryGateway methods the server calls (`HUB_DELIVERY`, product server code only). */
export type DeliveryBinding = Pick<DeliveryGateway, 'postNotice' | 'listChannels' | 'checkChannel'>

export interface NotifyCtx {
  db: D1Database
  /** Null when this Worker has no delivery binding: the alerts copy answers `slack_unavailable`, the bell still works. */
  delivery: DeliveryBinding | null
  nowMs: number
  requestId: string
}

export type Detail =
  | 'not_listed' | 'shared_channel' | 'archived' | 'not_public' | 'not_member' | 'not_found' | 'run_cap' | 'day_cap'
  | 'too_long' | 'empty' | 'unknown_member' | 'slack_not_connected' | 'slack_unavailable' | 'rate_limited'
  | 'no_alerts_channel' | 'app_origin_missing'
  // Written before M2-N (M2-F's closed Slack legs, or the stage rule before it); new rows never hold them, but a repeat
  // can read one back.
  | 'channel_to_bell' | 'slack_off' | 'to_bell' | 'below_act'

/** The agent's post to a listed channel, as the outbox answered it (Stage 1 M2-N). */
export type SlackLegAnswer =
  /** Nothing was asked or sent. `reason` is the outbox's code (or the leg's own: no wiring, not admitted); `text` its words. */
  | { kind: 'refused'; reason: string; text: string }
  /** The action the outbox made (`created`) or found: a card waiting for a person, or approved under a grant. */
  | { kind: 'action'; actionId: string; state: ActionState; verdict: 'run' | 'ask' | 'exact'; created: boolean }

/** Proposes one post to one listed channel through the outbox (built by the notifications tool: notifications/slack-leg.ts). */
export interface SlackLeg {
  propose(channel: ListedChannel, post: { title: string; text: string }): Promise<SlackLegAnswer>
}

/** One recipient's outcome. `skipped`: nothing reserved or sent for it (the Slack part with no alerts channel). */
export type RecipientOutcome = {
  kind: SendKind
  /** What the caller named: a member id, a channel name, or `alerts`. */
  to: string
  /** `asked`: the agent's post to a listed channel is an outbox action now (`action`); nothing went out yet. */
  outcome: 'posted' | 'refused' | 'failed' | 'unknown' | 'skipped' | 'asked'
  detail?: Detail
  /** Where a bell notice went when it wasn't the named recipient: a member id or `admins`. */
  bell?: string
  repeat?: true
  /** The agent's post to a listed channel: the action the outbox made or found. */
  action?: { id: string; state: ActionState; verdict: 'run' | 'ask' | 'exact'; created: boolean }
  /** The agent's post to a listed channel, refused by the outbox: its code and plain words (nothing asked or sent). */
  refusal?: { reason: string; text: string }
}

const SLACK_ACCOUNT = 'slack:workspace' as const

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
/** A notice id: `n_` + 128 random bits (the `notify_sends` row and its bell notice share it). */
export const newNoticeId = (): string => `n_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('')
}

const cp = (s: string) => [...s].length

// ---------- reads ----------

/** The ids among `ids` that are active brand people (kind `person`, status `active`, either role). */
export async function activePeople(db: D1Database, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await all<{ id: string }>(db, stmt(
    `SELECT id FROM members WHERE kind = 'person' AND status = 'active' AND id IN (${ids.map(() => '?').join(', ')})`, ...ids,
  ))
  return new Set(rows.map(r => r.id))
}

export type ListedChannel = { channelId: string; name: string; alerts: boolean }

export async function listedChannels(db: D1Database): Promise<ListedChannel[]> {
  const rows = await all<{ channel_id: string; name: string; alerts: number }>(db, stmt(
    'SELECT channel_id, name, alerts FROM notify_channels WHERE removed_at_ms IS NULL ORDER BY lower(name)',
  ))
  return rows.map(r => ({ channelId: r.channel_id, name: r.name, alerts: r.alerts === 1 }))
}

/** A channel name as the agent may write it: exact, case-insensitive, an optional leading `#`. */
export const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase()

// ---------- the hub's answer ----------

const CHANNEL_REFUSALS = new Set<Detail>(['shared_channel', 'archived', 'not_public', 'not_member', 'not_found'])

/** A hub error as a recipient's outcome and detail (closed codes only; the message's safe suffix for a refusal). */
export function fromHubError(e: { code: string; message: string }): { outcome: 'refused' | 'failed'; detail: Detail } {
  const suffix = e.message.includes(': ') ? e.message.slice(e.message.lastIndexOf(': ') + 2) : ''
  if (e.code === 'connect_refused' && CHANNEL_REFUSALS.has(suffix as Detail)) return { outcome: 'refused', detail: suffix as Detail }
  if (e.code === 'invalid_args' && (suffix === 'too_long' || suffix === 'empty')) return { outcome: 'refused', detail: suffix }
  // The hub's APP_ORIGIN is unset or malformed: the linked post is refused (fail loud), and it says so, not "not connected".
  if (e.code === 'not_configured' && suffix === 'APP_ORIGIN') return { outcome: 'refused', detail: 'app_origin_missing' }
  if (['paused', 'scope_mismatch', 'not_configured', 'credentials_rejected', 'key_unavailable'].includes(e.code)) return { outcome: 'refused', detail: 'slack_not_connected' }
  if (e.code === 'rate_limited') return { outcome: 'failed', detail: 'rate_limited' }
  return { outcome: 'failed', detail: 'slack_unavailable' }
}

// ---------- one recipient ----------

type Common = {
  ctx: NotifyCtx
  actorId: string
  sha: string
  textLength: number
  changed: string[]
  audit: Pick<Extract<AuditArgs, { action: 'notify.send' }>, 'source' | 'runId' | 'systemKey' | 'noticeKind'>
}

function auditLine(c: Common, kind: SendKind, target: string, outcome: 'posted' | 'refused' | 'failed' | 'unknown', detail?: Detail, repeat?: true): Stmt {
  const args: AuditArgs = {
    action: 'notify.send',
    ...c.audit,
    kind,
    target,
    outcome,
    ...(detail ? { detail } : {}),
    ...(c.changed.length > 0 ? { changed: c.changed as ('links' | 'mentions' | 'link_dropped')[] } : {}),
    ...(repeat ? { repeat } : {}),
    textLength: Math.min(c.textLength, 2000),
    noticeSha256: c.sha,
  }
  const targetRef = target === 'admins' || target === 'unlisted' ? null : kind === 'slack' ? { kind: 'channel' as const, id: target } : { kind: 'member' as const, id: target }
  return auditInsert({ atMs: c.ctx.nowMs, actorId: c.actorId, args, target: targetRef, requestId: c.ctx.requestId }, null)
}

const prepared = (db: D1Database, s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params)

async function batch(db: D1Database, stmts: readonly (Stmt | D1PreparedStatement)[]): Promise<void> {
  await storage('D1', () => db.batch(stmts.map(s => ('sql' in s && 'params' in s ? prepared(db, s as Stmt) : (s as D1PreparedStatement)))))
}

/** A row that already existed for this dedupe key: the first call's outcome, nothing sent. */
function repeatOf(row: SendRow): { outcome: 'posted' | 'refused' | 'failed' | 'unknown'; detail?: Detail } {
  if (row.outcome === 'reserved') return { outcome: 'unknown' }
  return { outcome: row.outcome, ...(row.detail ? { detail: row.detail as Detail } : {}) }
}

type Reserve = { stmt: Stmt; readBack: () => Promise<SendRow | null>; agent: boolean; runId: string | null; kind: SendKind }

/** Reserves, then reads the dedupe key back: ours (`fresh`), a repeat, or a cap refusal (no row). */
async function reserve(c: Common, r: Reserve, id: string): Promise<{ fresh: true } | { fresh: false; row: SendRow } | { fresh: false; cap: 'run_cap' | 'day_cap' }> {
  await batch(c.ctx.db, [r.stmt])
  const row = await r.readBack()
  if (row?.id === id) return { fresh: true }
  if (row) return { fresh: false, row }
  return { fresh: false, cap: await capHit(c.ctx.db, { agent: r.agent, runId: r.runId, kind: r.kind, atMs: c.ctx.nowMs }) }
}

type BellNotice = { template: string; body?: string; link: NoticeLinkInput | null }

async function toBell(c: Common, r: (id: string, target: string) => Reserve, to: string, target: string, n: BellNotice, detail?: Detail): Promise<RecipientOutcome> {
  const id = newNoticeId()
  const res = await reserve(c, r(id, target), id)
  const named = to === target ? {} : { bell: target }
  if (!res.fresh) {
    if ('cap' in res) {
      await batch(c.ctx.db, [auditLine(c, 'bell', target, 'refused', res.cap)])
      return { kind: 'bell', to, outcome: 'refused', detail: res.cap, ...named }
    }
    // A listed channel's notice and a member's own notice can repeat each other's bell row (same person, same text). A
    // posted repeat carries this call's detail, not the stored row's: a channel says it went to the bell instead (never
    // read as a Slack post), and a member's repeat never says a channel's words.
    const stored = repeatOf(res.row)
    const rep: ReturnType<typeof repeatOf> = stored.outcome === 'posted' ? { outcome: 'posted', ...(detail ? { detail } : {}) } : stored
    await batch(c.ctx.db, [auditLine(c, 'bell', target, rep.outcome, rep.detail, true)])
    return { kind: 'bell', to, ...rep, repeat: true, ...named }
  }
  await batch(c.ctx.db, [
    settle(id, 'posted', detail ?? null, null),
    addNotice(c.ctx.db, {
      id,
      audience: target === 'admins' ? 'admins' : 'member',
      ...(target === 'admins' ? {} : { audienceMemberId: target }),
      template: n.template,
      fields: {},
      ...(n.body !== undefined ? { body: n.body } : {}),
      icon: 'agent',
      link: bellLink(n.link),
      atMs: c.ctx.nowMs,
    }),
    auditLine(c, 'bell', target, 'posted', detail),
  ])
  return { kind: 'bell', to, outcome: 'posted', ...(detail ? { detail } : {}), ...named }
}

type SlackNotice = { title: string; text: string; link: NoticeLinkInput | null }

async function toSlack(c: Common, r: (id: string, target: string) => Reserve, to: string, channelId: string, n: SlackNotice, job: string): Promise<RecipientOutcome> {
  const delivery = c.ctx.delivery
  if (!delivery) {
    await batch(c.ctx.db, [auditLine(c, 'slack', channelId, 'failed', 'slack_unavailable')])
    return { kind: 'slack', to, outcome: 'failed', detail: 'slack_unavailable' }
  }
  const id = newNoticeId()
  const res = await reserve(c, r(id, channelId), id)
  if (!res.fresh) {
    if ('cap' in res) {
      await batch(c.ctx.db, [auditLine(c, 'slack', channelId, 'refused', res.cap)])
      return { kind: 'slack', to, outcome: 'refused', detail: res.cap }
    }
    const rep = repeatOf(res.row)
    await batch(c.ctx.db, [auditLine(c, 'slack', channelId, rep.outcome, rep.detail, true)])
    return { kind: 'slack', to, ...rep, repeat: true }
  }
  let answer: HubResult<{ ts: string }>
  try {
    // Copied and released at once (shared/rpc-answer.ts), a backstop: an answer that carries a disposer or stubs keeps
    // its call open until released, and this sender can run inside BrandAgent. The fix is the hub's.
    answer = plainAnswer(await delivery.postNotice({ kind: 'server', job, requestId: c.ctx.requestId }, {
      accountId: SLACK_ACCOUNT, channelId, title: n.title, text: n.text, noticeId: id, ...(n.link ? { link: n.link } : {}),
    }))
  } catch {
    // No answer: the row stays `reserved` and nothing re-sends it (at most once).
    await batch(c.ctx.db, [auditLine(c, 'slack', channelId, 'unknown')])
    return { kind: 'slack', to, outcome: 'unknown' }
  }
  if (answer.ok) {
    await batch(c.ctx.db, [settle(id, 'posted', null, answer.value.ts), auditLine(c, 'slack', channelId, 'posted')])
    return { kind: 'slack', to, outcome: 'posted' }
  }
  const { outcome, detail } = fromHubError(answer.error)
  await batch(c.ctx.db, [settle(id, outcome, detail, null), auditLine(c, 'slack', channelId, outcome, detail)])
  return { kind: 'slack', to, outcome, detail }
}

const changedList = (b: BoundChanges, linkDropped: boolean): string[] =>
  [b.links ? 'links' : null, b.mentions ? 'mentions' : null, linkDropped ? 'link_dropped' : null].filter((x): x is string => x !== null)

// ---------- the agent: notification_send ----------

export type AgentScope = { memberId: string; chatId: string; runId: string; turnId: string }

export type AgentNoticeInput = {
  to: { members?: string[]; channels?: string[] }
  title: string
  text: string
  format: NoticeFormat
  link?: { kind: NoticeLinkInput['kind']; id?: string }
}

export type AgentNoticeResult = { recipients: RecipientOutcome[]; changed: string[]; listed: string[] }

/** What `notifyAgent` needs: the database and this call's clock and id, and the Slack leg (null: no wiring, so refused). */
export type AgentNotifyCtx = Omit<NotifyCtx, 'delivery'> & { slack: SlackLeg | null }

/** The leg's own refusal when the tool has no wiring (a caller with no egress behind it): nothing asked or sent. */
export const NO_SLACK_LEG: SlackLegAnswer = { kind: 'refused', reason: 'actions_unavailable', text: 'Slack posts can’t be asked for from here, so nothing was asked or sent.' }

export async function notifyAgent(ctx: AgentNotifyCtx, scope: AgentScope, input: AgentNoticeInput): Promise<AgentNoticeResult> {
  const members = [...new Set(input.to.members ?? [])]
  const channels = [...new Set(input.to.channels ?? [])]
  const link = input.link === undefined ? null : checkLink(input.link)
  const linkDropped = input.link !== undefined && link === null
  const bounded = boundNotice({ title: input.title, text: input.text, format: input.format }, { escape: false })
  const sha = await sha256Hex(JSON.stringify(bounded.ok ? [bounded.title, bounded.text, link] : [input.title, input.text, link]))
  const c: Common = {
    ctx: { ...ctx, delivery: null },
    actorId: scope.memberId,
    sha,
    textLength: bounded.ok ? cp(bounded.text) : cp(input.text),
    changed: bounded.ok ? changedList(bounded.changed, linkDropped) : [],
    audit: { source: 'agent', runId: scope.runId },
  }
  const listed = await listedChannels(ctx.db)
  const byKey = new Map(listed.map(l => [channelKey(l.name), l]))
  const listedNames = listed.map(l => `#${l.name}`)
  const out: AgentNoticeResult = { recipients: [], changed: c.changed, listed: listedNames }

  const people = await activePeople(ctx.db, members)
  if (!bounded.ok) {
    // Refused, never truncated: one audited line per recipient, nothing reserved or sent.
    const lines: Stmt[] = []
    for (const m of members) {
      lines.push(...(people.has(m) ? [auditLine(c, 'bell', m, 'refused', bounded.reason)] : []))
      out.recipients.push({ kind: 'bell', to: m, outcome: 'refused', detail: people.has(m) ? bounded.reason : 'unknown_member' })
    }
    for (const name of channels) {
      const l = byKey.get(channelKey(name))
      // An unlisted name is audited as `unlisted`, never by the name: that's the agent's text.
      lines.push(l ? auditLine(c, 'slack', l.channelId, 'refused', bounded.reason) : auditLine(c, 'slack', 'unlisted', 'refused', 'not_listed'))
      out.recipients.push({ kind: 'slack', to: name, outcome: 'refused', detail: l ? bounded.reason : 'not_listed' })
    }
    if (lines.length > 0) await batch(ctx.db, lines)
    return out
  }

  const bell: BellNotice = { template: input.format === 'report' ? 'notify_report' : 'notify_message', body: `${bounded.title}\n\n${bounded.text}`, link }
  const agentReserve = (kind: SendKind) => (id: string, target: string): Reserve => ({
    stmt: reserveAgent({ id, runId: scope.runId, turnId: scope.turnId, actorId: scope.memberId, kind, target, sha, atMs: ctx.nowMs }),
    readBack: () => agentRow(ctx.db, { runId: scope.runId, kind, target, sha }),
    agent: true,
    runId: scope.runId,
    kind,
  })

  for (const m of members) {
    if (!people.has(m)) {
      // No audit target: an unknown id names nobody. Nothing written.
      out.recipients.push({ kind: 'bell', to: m, outcome: 'refused', detail: 'unknown_member' })
      continue
    }
    out.recipients.push(await toBell(c, agentReserve('bell'), m, m, bell))
  }
  for (const name of channels) {
    const l = byKey.get(channelKey(name))
    if (!l) {
      // Audited as `unlisted`, never by the name: that's the agent's text.
      await batch(ctx.db, [auditLine(c, 'slack', 'unlisted', 'refused', 'not_listed')])
      out.recipients.push({ kind: 'slack', to: name, outcome: 'refused', detail: 'not_listed' })
      continue
    }
    // Q3 = A: the same rule as any Slack post. The outbox audits what it does (`action.requested`); a refusal writes
    // nothing there, as for any write tool. The app link isn't part of a post the outbox makes.
    const a = ctx.slack ? await ctx.slack.propose(l, { title: bounded.title, text: bounded.text }) : NO_SLACK_LEG
    out.recipients.push(a.kind === 'refused'
      ? { kind: 'slack', to: name, outcome: 'refused', refusal: { reason: a.reason, text: a.text } }
      : { kind: 'slack', to: name, outcome: 'asked', action: { id: a.actionId, state: a.state, verdict: a.verdict, created: a.created } })
  }
  return out
}

// ---------- the server's own notices: sendSystemNotice ----------

export type SystemNoticeInput = {
  key: string
  source: SystemSource
  kind: SystemNoticeKind
  runId?: string
  to: { members?: string[]; alertsChannel?: true }
  body?: string
  link: { kind: NoticeLinkInput['kind']; id?: string }
}

export type SystemNoticeResult = { ok: true; recipients: RecipientOutcome[] } | { ok: false; error: 'invalid_args' }

const KEY = /^[A-Za-z0-9:_.-]{1,128}$/
const RUN_ID = /^r_[A-Za-z0-9_-]{22}$/
const MEMBER_ID = /^m_[A-Za-z0-9_-]{1,64}$/
const SOURCES = new Set(['approvals', 'questions', 'routines'])

/** The input checked by hand (no zod in this path), or null: `invalid_args`, no row written. */
function checkSystemInput(input: SystemNoticeInput): { kind: StoredSystemKind; link: NoticeLinkInput; members: string[] } | null {
  if (typeof input !== 'object' || input === null) return null
  const kind = storedKind(input.kind)
  if (!kind || typeof input.key !== 'string' || !KEY.test(input.key) || !SOURCES.has(input.source)) return null
  if (input.runId !== undefined && (typeof input.runId !== 'string' || !RUN_ID.test(input.runId))) return null
  if (input.body !== undefined && typeof input.body !== 'string') return null
  const link = checkLink(input.link)
  if (!link) return null
  const to = input.to
  if (typeof to !== 'object' || to === null) return null
  if (to.alertsChannel !== undefined && to.alertsChannel !== true) return null
  const members = to.members ?? []
  if (!Array.isArray(members) || members.length > 50 || members.some(m => typeof m !== 'string' || !MEMBER_ID.test(m))) return null
  if (members.length === 0 && !to.alertsChannel) return null
  return { kind, link, members: [...new Set(members)] }
}

/**
 * The server's own notice (section 3a, OC-W4-7): members' bells and the admin-marked alerts channel in one call, each
 * recipient with its own row and outcome. The title is the kind's template; model text only ever in the bounded `body`.
 * Dedupe on the caller's whole key: a repeat within one key returns the first outcome and sends nothing.
 */
export async function sendSystemNotice(
  env: { DB: D1Database; HUB_DELIVERY?: unknown },
  input: SystemNoticeInput,
  opts: { nowMs?: number; requestId?: string } = {},
): Promise<SystemNoticeResult> {
  const checked = checkSystemInput(input)
  if (!checked) return { ok: false, error: 'invalid_args' }
  const ctx: NotifyCtx = {
    db: env.DB,
    delivery: (env.HUB_DELIVERY as DeliveryBinding | undefined) ?? null,
    nowMs: opts.nowMs ?? Date.now(),
    requestId: opts.requestId ?? `notice-${newNoticeId()}`,
  }
  const title = systemTitle(checked.kind)
  const bounded = input.body === undefined ? null : boundBody(input.body, { escape: false, max: SYSTEM_BODY_MAX })
  const body = bounded?.ok ? bounded.text : undefined
  const sha = await sha256Hex(JSON.stringify([title, body ?? null, checked.link]))
  const c: Common = {
    ctx,
    actorId: SYSTEM_MEMBER_ID,
    sha,
    textLength: body !== undefined ? cp(body) : input.body !== undefined ? cp(input.body) : 0,
    changed: bounded?.ok ? changedList(bounded.changed, false) : [],
    audit: { source: input.source, systemKey: input.key, noticeKind: checked.kind, ...(input.runId ? { runId: input.runId } : {}) },
  }
  const people = await activePeople(ctx.db, checked.members)
  const recipients: RecipientOutcome[] = []

  const alerts = input.to.alertsChannel ? (await listedChannels(ctx.db)).find(l => l.alerts) ?? null : null

  if (bounded && !bounded.ok) {
    const lines: Stmt[] = []
    for (const m of checked.members) {
      if (people.has(m)) lines.push(auditLine(c, 'bell', m, 'refused', bounded.reason))
      recipients.push({ kind: 'bell', to: m, outcome: 'refused', detail: people.has(m) ? bounded.reason : 'unknown_member' })
    }
    if (input.to.alertsChannel) {
      if (alerts) lines.push(auditLine(c, 'slack', alerts.channelId, 'refused', bounded.reason))
      recipients.push({ kind: 'slack', to: 'alerts', outcome: 'refused', detail: bounded.reason })
    }
    if (lines.length > 0) await batch(ctx.db, lines)
    return { ok: true, recipients }
  }

  const runId = input.runId ?? null
  const systemReserve = (kind: SendKind) => (id: string, target: string): Reserve => ({
    stmt: reserveSystem({ id, source: input.source, runId, key: input.key, noticeKind: checked.kind, actorId: SYSTEM_MEMBER_ID, kind, target, sha, atMs: ctx.nowMs }),
    readBack: () => systemRow(ctx.db, { source: input.source, key: input.key, noticeKind: checked.kind, kind, target }),
    agent: false,
    runId,
    kind,
  })
  for (const m of checked.members) {
    if (!people.has(m)) {
      recipients.push({ kind: 'bell', to: m, outcome: 'refused', detail: 'unknown_member' })
      continue
    }
    recipients.push(await toBell(c, systemReserve('bell'), m, m, { template: checked.kind, ...(body !== undefined ? { body } : {}), link: checked.link }))
  }
  if (input.to.alertsChannel) {
    if (!alerts) recipients.push({ kind: 'slack', to: 'alerts', outcome: 'skipped', detail: 'no_alerts_channel' })
    // Q3 = A: the server's own fixed notice goes to the alerts channel without a card.
    else recipients.push(await toSlack(c, systemReserve('slack'), 'alerts', alerts.channelId, { title, text: body ?? NO_BODY_TEXT, link: checked.link }, `system:${input.source}`))
  }
  return { ok: true, recipients }
}
