// P3's `memory` store slot (p3-design sections 10 and 12). Owner: W6 (p3-w6.md). What the agent remembers, over D1:
// the memory tools (search, save, update, forget, list) and the Memory pages' routes (43 to 45) read and write through
// it. Every method takes data and returns data (the store contract in server/routes.ts).
// - A person fact counts at once (`active`); a brand fact waits for an admin's OK (`waiting`), unless the brand turned
//   off "Ask before saving a team rule" (`m:ask`) and a person's agent saved it; changing a brand fact follows the
//   same rule, so a change never skips the approval. A routine's (`m_system`) brand fact always waits.
// - A person's `m:learn` off refuses their saves and rewords, in the same statement that would write.
// - Every write is one statement guarded by owner, `rev` and status (a team-fact forget adds its audit line in the same
//   batch, written only when the change matched a row).
// - Reads go through the one visibility rule (visibility.ts); the routes' owner checks read a fact by id first.
// - Customer personal data is refused on save and update (personal-data.ts), with a reason the agent can read.
import type { MemoryLine } from '../../../../shared/contract/memory.ts'
import { auditInsert } from '../../../db/audit.ts'
import { SYSTEM_MEMBER_ID, writeStamp } from '../../../db/ids.ts'
import type { At } from '../../../db/members.ts'
import { all, first, runBatch, stmt } from '../../../db/sql.ts'
import type { SqlValue } from '../../../db/sql.ts'
import { personalDataIn } from './personal-data.ts'
import type { PersonalDataKind } from './personal-data.ts'
import { factVisible, matchExpression } from './visibility.ts'

export type MemoryScope = 'brand' | 'person'
export type MemoryStatus = 'active' | 'waiting' | 'forgotten'

/** A saved fact as the store returns it. */
export interface Fact {
  /** The FTS rowid; the tools' list cursor. */
  n: number
  id: string
  scope: MemoryScope
  ownerId: string | null
  text: string
  status: MemoryStatus
  sourceChatId: string | null
  createdBy: string
  /** The saver's current name (null once pseudonymised or for an unknown id); `createdByService` for a service row. */
  createdByName: string | null
  createdByService: boolean
  createdAtMs: number
  updatedAtMs: number
  usedCount: number
  lastUsedAtMs: number | null
  rev: number
}

/** Why a save or an update was refused. */
export type WriteRefusal =
  | { refused: 'personal_data'; kind: PersonalDataKind }
  /** A service member (a routine's run, `m_system`) never saves a person fact every routine would then read. */
  | { refused: 'service_person_fact' }
  /** The run's member isn't an active member any more. */
  | { refused: 'no_member' }
  /** This person turned off "Learn from my chats" (`m:learn`): nothing is saved or reworded for them. */
  | { refused: 'learning_off' }

export type SaveResult = { saved: Fact } | { duplicate: Fact } | WriteRefusal
export type UpdateResult = { updated: Fact } | { unchanged: Fact } | { notFound: true } | { conflict: true } | WriteRefusal
export type ForgetOwnResult = { forgotten: Fact } | { notFound: true } | { brandFact: true } | { conflict: true }
/** A route write: the fact as it is after the change, the fact as it is now (stale or wrong status), or no such fact. */
export type SetForgottenResult = { ok: Fact } | { conflict: Fact } | { notFound: true }

export interface MemoryStore {
  /** Visible facts matching `query` (words or "a phrase"), best first; counts each as used once. */
  search(memberId: string, query: string, limit: number, nowMs: number): Promise<Fact[]>
  /** Visible facts, newest first, after the fact numbered `beforeN` (a cursor), optionally of one scope. */
  list(memberId: string, opts: { scope?: MemoryScope; beforeN: number | null; limit: number }): Promise<Fact[]>
  /** A visible fact by id, or null. */
  visible(memberId: string, id: string): Promise<Fact | null>
  /** Saves a new fact for `memberId` (person scope: theirs; brand scope: the team's, waiting unless `m:ask` is off and a person saved it). */
  save(input: { memberId: string; scope: MemoryScope; text: string; chatId: string | null; nowMs: number; requestId: string }): Promise<SaveResult>
  /** Rewords a visible fact; a brand fact goes back to waiting (unless `m:ask` is off and a person reworded it). */
  update(input: { memberId: string; id: string; text: string; nowMs: number; requestId: string }): Promise<UpdateResult>
  /** The agent's forget: only the member's own active person fact. */
  forgetOwn(input: { memberId: string; id: string; nowMs: number; requestId: string }): Promise<ForgetOwnResult>
  /** Route 43's data: every fact visible to `memberId`, the team's and their own, newest first (at most 1000 of each). */
  page(memberId: string): Promise<{ team: Fact[]; personal: Fact[] }>
  /** Any fact by id, whatever its status (the routes' owner check reads it first). */
  byId(id: string): Promise<Fact | null>
  /** Route 44: the owner forgets their person fact (`true`), or undoes that, at `ifRev`. */
  setPersonForgotten(input: { id: string; ownerId: string; forgotten: boolean; ifRev: number }, at: At): Promise<SetForgottenResult>
  /**
   * Route 45: an Admin (or the Inhouse team under a grant) forgets a team fact, active or waiting (`true`), or undoes
   * that (it waits for an admin's OK again), at `ifRev`. Writes `memory.forgotten` or `memory.restored`, by `at.actorId`.
   */
  setBrandForgotten(input: { id: string; forgotten: boolean; ifRev: number }, at: At): Promise<SetForgottenResult>
  /**
   * P6a (W2), route 78: an Admin (or the Inhouse team under a grant) approves a waiting team fact (`active`) or rejects
   * it (`forgotten`), at `ifRev`. Only from `waiting`. Writes `memory.approved` or `memory.rejected` with the revision
   * decided, by `at.actorId`, in the same batch.
   */
  setBrandApproved(input: { id: string; approved: boolean; ifRev: number }, at: At): Promise<SetForgottenResult>
  /**
   * P6a (W2), route 77: the team's waiting facts, newest first, at most `limit` held to 1 to `WAITING_MAX` (a
   * non-number throws). The only read of waiting facts.
   */
  waiting(limit: number): Promise<Fact[]>
}

interface FactRow {
  n: number
  id: string
  scope: MemoryScope
  owner_id: string | null
  text: string
  status: MemoryStatus
  source_chat_id: string | null
  created_by: string
  created_at_ms: number
  updated_at_ms: number
  used_count: number
  last_used_at_ms: number | null
  rev: number
  creator_name: string | null
  creator_kind: string | null
}

const COLUMNS = `m.n, m.id, m.scope, m.owner_id, m.text, m.status, m.source_chat_id, m.created_by, m.created_at_ms,
  m.updated_at_ms, m.used_count, m.last_used_at_ms, m.rev, c.name AS creator_name, c.kind AS creator_kind`
const FROM = 'FROM memories m LEFT JOIN members c ON c.id = m.created_by'

const fact = (r: FactRow): Fact => ({
  n: r.n, id: r.id, scope: r.scope, ownerId: r.owner_id, text: r.text, status: r.status, sourceChatId: r.source_chat_id,
  createdBy: r.created_by, createdByName: r.creator_name, createdByService: r.creator_kind === 'service',
  createdAtMs: r.created_at_ms, updatedAtMs: r.updated_at_ms, usedCount: r.used_count, lastUsedAtMs: r.last_used_at_ms, rev: r.rev,
})

/** A switch row that is off: the settings store writes `false` as the text `false`; a reset (`null`) or a missing row is on. */
const SWITCH_OFF = (owner: string, key: string) => `EXISTS (SELECT 1 FROM settings WHERE owner = ${owner} AND key = '${key}' AND value_json = 'false')`
/** The status a brand fact gets when `saver` writes it (one `?`: the saver's member id): active only when `m:ask` is off and the saver is a person, never a service member (a routine, the smoke row). */
const BRAND_STATUS = `CASE WHEN EXISTS (SELECT 1 FROM members WHERE id = ? AND kind <> 'service') AND ${SWITCH_OFF("'brand'", 'm:ask')} THEN 'active' ELSE 'waiting' END`

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** The most waiting facts `waiting()` ever returns (SQLite reads a negative LIMIT as no limit, so it's clamped here). */
export const WAITING_MAX = 200

/** A new fact id: `mem_` + 128 random bits. */
export const newMemoryId = (): string => `mem_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** The fact as the Memory pages show it (`MemoryLine`). */
export function factLine(f: Fact): MemoryLine {
  const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
  const source = f.createdByService
    ? 'Your Inhouse agent saved this during a routine'
    : `${f.createdByName ?? 'A former member'} told your Inhouse agent in a chat`
  return {
    key: f.id,
    text: f.text,
    source,
    at: instant(f.createdAtMs),
    ...(f.usedCount > 0 ? { used: f.usedCount === 1 ? 'used once' : `used ${f.usedCount} times` } : {}),
    ...(f.lastUsedAtMs !== null ? { lastUsed: instant(f.lastUsedAtMs) } : {}),
    rev: f.rev,
    scope: f.scope,
    ...(f.status === 'forgotten' ? { forgotten: true } : {}),
    ...(f.status === 'waiting' ? { waiting: true as const } : {}),
  }
}

export function memoryStore({ db }: { db: D1Database }): MemoryStore {
  const byId = async (id: string) => {
    const r = await first<FactRow>(db, stmt(`SELECT ${COLUMNS} ${FROM} WHERE m.id = ?`, id))
    return r && fact(r)
  }
  const visible = async (memberId: string, id: string) => {
    const r = await first<FactRow>(db, stmt(`SELECT ${COLUMNS} ${FROM} WHERE m.id = ? AND ${factVisible('m')}`, id, memberId))
    return r && fact(r)
  }
  // D1's `meta.changes` counts the FTS triggers' writes too, so a statement that changed its one row reports more than 1:
  // every check here is "changed any" (each statement names one row by its unique id).
  const changes = async (sql: string, ...params: SqlValue[]) => (await runBatch(db, [stmt(sql, ...params)]))[0].meta.changes
  const learningOff = async (memberId: string) =>
    (await first<{ n: number }>(db, stmt(`SELECT 1 AS n WHERE ${SWITCH_OFF('?', 'm:learn')}`, memberId))) !== null
  const memberActive = async (memberId: string) =>
    (await first<{ n: number }>(db, stmt("SELECT 1 AS n FROM members WHERE id = ? AND status = 'active'", memberId))) !== null
  /** After a guarded write: the change, the fact as it is now, or no such fact (of that scope and owner). */
  const settle = async (changed: number, id: string, scope: MemoryScope, ownerId: string | null): Promise<SetForgottenResult> => {
    const now = await byId(id)
    if (!now || now.scope !== scope || (ownerId !== null && now.ownerId !== ownerId)) return { notFound: true }
    return changed > 0 ? { ok: now } : { conflict: now }
  }

  return {
    async search(memberId, query, limit, nowMs) {
      const match = matchExpression(query)
      if (match === null) return []
      const rows = await all<FactRow>(db, stmt(
        `SELECT ${COLUMNS} FROM memories_fts f JOIN memories m ON m.n = f.rowid LEFT JOIN members c ON c.id = m.created_by
         WHERE memories_fts MATCH ? AND ${factVisible('m')} ORDER BY bm25(memories_fts), m.n DESC LIMIT ?`,
        match, memberId, limit,
      ))
      if (rows.length > 0) {
        // Counted, not versioned: `rev` stays (a page's ifRev isn't stale because the agent read a fact).
        await changes(`UPDATE memories SET used_count = used_count + 1, last_used_at_ms = ? WHERE n IN (${rows.map(() => '?').join(', ')})`, nowMs, ...rows.map(r => r.n))
      }
      return rows.map(fact)
    },

    async list(memberId, { scope, beforeN, limit }) {
      const rows = await all<FactRow>(db, stmt(
        `SELECT ${COLUMNS} ${FROM} WHERE ${factVisible('m')} AND (? IS NULL OR m.scope = ?) AND (? IS NULL OR m.n < ?) ORDER BY m.n DESC LIMIT ?`,
        memberId, scope ?? null, scope ?? null, beforeN, beforeN, limit,
      ))
      return rows.map(fact)
    },

    visible,

    async save({ memberId, scope, text, chatId, nowMs, requestId }) {
      if (scope === 'person' && memberId === SYSTEM_MEMBER_ID) return { refused: 'service_person_fact' }
      const kind = personalDataIn(text)
      if (kind) return { refused: 'personal_data', kind }
      const ownerId = scope === 'person' ? memberId : null
      const id = newMemoryId()
      // One statement: written only for an active member, never twice (the same text, scope and owner, still active or
      // waiting: an agent's retry after a lost answer finds the first), and for a person fact only while their `m:learn`
      // isn't off. A brand fact's status is decided here too, from `m:ask` as it is when the statement runs.
      const changed = await changes(
        `INSERT INTO memories (id, scope, owner_id, text, status, source_chat_id, created_by, created_at_ms, updated_at_ms, req_id)
         SELECT ?, ?, ?, ?, ${scope === 'person' ? "'active'" : BRAND_STATUS}, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM members WHERE id = ? AND status = 'active')
           AND NOT EXISTS (SELECT 1 FROM memories WHERE scope = ? AND owner_id IS ? AND text = ? AND status IN ('active', 'waiting'))${scope === 'person' ? ` AND NOT ${SWITCH_OFF('?', 'm:learn')}` : ''}`,
        id, scope, ownerId, text, ...(scope === 'person' ? [] : [memberId]), chatId, memberId, nowMs, nowMs, writeStamp(requestId),
        memberId, scope, ownerId, text, ...(scope === 'person' ? [memberId] : []),
      )
      if (changed > 0) return { saved: (await byId(id))! }
      // A reword or an admin's restore can leave the same text live twice (one active, one waiting). The duplicate is
      // then the active one, the oldest of those: the agent acts on this id next, and the tools see only active facts.
      const same = await first<FactRow>(db, stmt(
        `SELECT ${COLUMNS} ${FROM} WHERE m.scope = ? AND m.owner_id IS ? AND m.text = ? AND m.status IN ('active', 'waiting')
         ORDER BY m.status <> 'active', m.n LIMIT 1`, scope, ownerId, text,
      ))
      if (same) return { duplicate: fact(same) }
      // Nothing was written and nothing is a duplicate: a person fact is refused for `m:learn` while the member is
      // still active (the switch is read now, so one flipped back since still gives the member's own reason).
      return scope === 'person' && await memberActive(memberId) ? { refused: 'learning_off' } : { refused: 'no_member' }
    },

    async update({ memberId, id, text, nowMs, requestId }) {
      const current = await visible(memberId, id)
      if (!current) return { notFound: true }
      if (current.scope === 'person' && memberId === SYSTEM_MEMBER_ID) return { refused: 'service_person_fact' }
      const kind = personalDataIn(text)
      if (kind) return { refused: 'personal_data', kind }
      if (current.text === text) return { unchanged: current }
      // A person fact is reworded only while the owner's `m:learn` isn't off; a brand fact's new status follows `m:ask`.
      const changed = await changes(
        `UPDATE memories SET text = ?, status = CASE scope WHEN 'brand' THEN ${BRAND_STATUS} ELSE status END, rev = rev + 1,
           updated_at_ms = ?, req_id = ?
         WHERE id = ? AND rev = ? AND status = 'active'
           AND (scope = 'brand' OR (owner_id = ? AND NOT ${SWITCH_OFF('?', 'm:learn')}))`,
        text, memberId, nowMs, writeStamp(requestId), id, current.rev, memberId, memberId,
      )
      if (changed > 0) return { updated: (await byId(id))! }
      // A lost rev or status race is a conflict whatever the switch says; only an untouched fact refused for `m:learn` is learning_off.
      const now = await byId(id)
      const untouched = now !== null && now.rev === current.rev && now.status === 'active'
      return untouched && current.scope === 'person' && await learningOff(memberId) ? { refused: 'learning_off' } : { conflict: true }
    },

    async forgetOwn({ memberId, id, nowMs, requestId }) {
      const current = await visible(memberId, id)
      if (!current) return { notFound: true }
      if (current.scope === 'brand') return { brandFact: true }
      const changed = await changes(
        `UPDATE memories SET status = 'forgotten', rev = rev + 1, updated_at_ms = ?, req_id = ?
         WHERE id = ? AND rev = ? AND scope = 'person' AND owner_id = ? AND status = 'active'`,
        nowMs, writeStamp(requestId), id, current.rev, memberId,
      )
      return changed > 0 ? { forgotten: (await byId(id))! } : { conflict: true }
    },

    async page(memberId) {
      const rows = await all<FactRow>(db, stmt(
        `SELECT ${COLUMNS} ${FROM} WHERE ${factVisible('m')} ORDER BY m.n DESC LIMIT 2000`, memberId,
      ))
      const facts = rows.map(fact)
      return { team: facts.filter(f => f.scope === 'brand').slice(0, 1000), personal: facts.filter(f => f.scope === 'person').slice(0, 1000) }
    },

    byId,

    async setPersonForgotten({ id, ownerId, forgotten, ifRev }, at) {
      const [from, to] = forgotten ? ['active', 'forgotten'] : ['forgotten', 'active']
      const changed = await changes(
        `UPDATE memories SET status = ?, rev = rev + 1, updated_at_ms = ?, req_id = ?
         WHERE id = ? AND scope = 'person' AND owner_id = ? AND rev = ? AND status = ?`,
        to, at.nowMs, writeStamp(at.requestId), id, ownerId, ifRev, from,
      )
      return settle(changed, id, 'person', ownerId)
    },

    async setBrandForgotten({ id, forgotten, ifRev }, at) {
      // Forgetting takes an active or a waiting fact (an admin declining it); undoing sends it back to waiting.
      const [fromA, fromB, to] = forgotten ? ['active', 'waiting', 'forgotten'] : ['forgotten', 'forgotten', 'waiting']
      const stamp = writeStamp(at.requestId)
      const results = await runBatch(db, [
        stmt(
          `UPDATE memories SET status = ?, rev = rev + 1, updated_at_ms = ?, req_id = ?
           WHERE id = ? AND scope = 'brand' AND rev = ? AND status IN (?, ?)`,
          to, at.nowMs, stamp, id, ifRev, fromA, fromB,
        ),
        auditInsert({
          atMs: at.nowMs,
          actorId: at.actorId,
          args: { action: forgotten ? 'memory.forgotten' : 'memory.restored', memoryId: id },
          target: { kind: 'memory', id },
          requestId: at.requestId,
        }, { table: 'memories', where: 'id = ?', params: [id], stamp }),
      ])
      return settle(results[0].meta.changes, id, 'brand', null)
    },

    async setBrandApproved({ id, approved, ifRev }, at) {
      const stamp = writeStamp(at.requestId)
      const results = await runBatch(db, [
        stmt(
          `UPDATE memories SET status = ?, rev = rev + 1, updated_at_ms = ?, req_id = ?
           WHERE id = ? AND scope = 'brand' AND status = 'waiting' AND rev = ?`,
          approved ? 'active' : 'forgotten', at.nowMs, stamp, id, ifRev,
        ),
        auditInsert({
          atMs: at.nowMs,
          actorId: at.actorId,
          args: { action: approved ? 'memory.approved' : 'memory.rejected', memoryId: id, rev: ifRev },
          target: { kind: 'memory', id },
          requestId: at.requestId,
        }, { table: 'memories', where: 'id = ?', params: [id], stamp }),
      ])
      return settle(results[0].meta.changes, id, 'brand', null)
    },

    async waiting(limit) {
      if (!Number.isFinite(limit)) throw new Error(`waiting: limit is not a number: ${limit}`)
      const held = Math.min(WAITING_MAX, Math.max(1, Math.trunc(limit)))
      const rows = await all<FactRow>(db, stmt(
        `SELECT ${COLUMNS} ${FROM} WHERE m.scope = 'brand' AND m.status = 'waiting' ORDER BY m.n DESC LIMIT ?`, held,
      ))
      return rows.map(fact)
    },
  }
}
