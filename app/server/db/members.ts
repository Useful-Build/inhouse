// Members (p2-design section 7): sign-in binding, invite and re-invite, role change, removal, the last-Admin rule,
// renaming (`g:name`) and pseudonymising. Every guard sits in the statement's WHERE (never a read, then a write); a
// read only picks a candidate or explains a statement that matched nothing. Each write is one batch with its audit line.
import type { InviteInput, MemberRecord, MemberRole, MemberStatus } from '../../shared/contract/members.ts'
import type { Principal } from '../auth/principal.ts'
import type { SignIn, SignInRefusal } from '../auth/stores.ts'
import { auditInsert } from './audit.ts'
import type { AuditHook, Guard } from './audit.ts'
import { newMemberId, writeStamp } from './ids.ts'
import { photoUrl } from './photos.ts'
import { all, first, runBatch, stmt } from './sql.ts'
import type { Stmt } from './sql.ts'

/** Who writes, for which request, at the request's one clock. `actorId` is always a member id. */
export interface At {
  actorId: string
  requestId: string
  nowMs: number
}

export interface MemberRow {
  id: string
  kind: 'person' | 'inhouse' | 'service'
  role: MemberRole | null
  status: MemberStatus
  name: string | null
  title: string | null
  email_norm: string | null
  subject: string | null
  service_name: 'smoke' | 'system' | null
  photo_key: string | null
  rev: number
  created_at_ms: number
  invited_by: string | null
  removed_at_ms: number | null
  pseudonymised_at_ms: number | null
  req_id: string | null
}

/** The name a pseudonymised member shows everywhere (decision Q3). */
export const FORMER_MEMBER = 'Former member'

/** A person's row as the API serves it. */
export function memberRecord(row: MemberRow): MemberRecord {
  if (row.kind !== 'person' || row.role === null) throw new Error('memberRecord: not a person row')
  return {
    id: row.id,
    name: row.name ?? FORMER_MEMBER,
    email: row.email_norm,
    title: row.title,
    role: row.role,
    status: row.status,
    photo: row.photo_key ? photoUrl(row.id, row.photo_key) : null,
    rev: row.rev,
  }
}

/** `{ ok }` applied, `{ conflict }` a stale ifRev (with the record as it is now), `{ refused }` a rule said no. */
export type Outcome<T, R extends string> = { ok: T } | { conflict: T } | { refused: R }

const OPEN = "status IN ('invited', 'active')"
/** At least one other active Admin: the last-Admin guard, evaluated inside the statement. */
const ANOTHER_ADMIN = "(SELECT COUNT(*) FROM members WHERE kind = 'person' AND role = 'admin' AND status = 'active' AND id <> ?) >= 1"

const memberGuard = (id: string, stamp: string): Guard => ({ table: 'members', where: 'id = ?', params: [id], stamp })

// ---------- statement builders (pure: the seed renders them as SQL) ----------

/**
 * A new `invited` row and its `member.invited` line: inserted only while no open row has this email (the partial unique
 * index backs it up). `title` missing is NULL, never ''.
 */
export function newInviteStmts(input: InviteInput, at: At, id: string = newMemberId()): { id: string; stamp: string; stmts: Stmt[] } {
  const stamp = writeStamp(at.requestId)
  const email = input.email.trim().toLowerCase()
  return {
    id,
    stamp,
    stmts: [
      stmt(
        `INSERT INTO members (id, kind, role, status, name, title, email_norm, created_at_ms, invited_by, req_id)
         SELECT ?, 'person', ?, 'invited', ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM members WHERE kind = 'person' AND email_norm = ? AND ${OPEN})`,
        id, input.role, input.name, input.title ?? null, email, at.nowMs, at.actorId, stamp, email,
      ),
      auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'member.invited', memberId: id, role: input.role }, target: { kind: 'member', id }, requestId: at.requestId }, memberGuard(id, stamp)),
    ],
  }
}

function reinviteStmts(removedId: string, input: InviteInput, at: At): Stmt[] {
  const stamp = writeStamp(at.requestId)
  const email = input.email.trim().toLowerCase()
  return [
    stmt(
      `UPDATE members SET status = 'invited', role = ?, name = ?, title = ?, invited_by = ?, removed_at_ms = NULL, rev = rev + 1, req_id = ?
       WHERE id = ? AND kind = 'person' AND status = 'removed' AND email_norm = ? AND pseudonymised_at_ms IS NULL
         AND NOT EXISTS (SELECT 1 FROM members WHERE kind = 'person' AND email_norm = ? AND ${OPEN})`,
      input.role, input.name, input.title ?? null, at.actorId, stamp, removedId, email, email,
    ),
    auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'member.reinvited', memberId: removedId, role: input.role }, target: { kind: 'member', id: removedId }, requestId: at.requestId }, memberGuard(removedId, stamp)),
  ]
}

// ---------- the store ----------

export interface MemberStoreDeps {
  db: D1Database
  hook?: AuditHook
}

type PersonPrincipal = Omit<Extract<Principal, { kind: 'person' }>, 'expMs'>
type InhouseIdentity = Omit<Extract<Principal, { kind: 'inhouse' }>, 'grant' | 'expMs'>

export function memberStore({ db, hook = s => s }: MemberStoreDeps) {
  /** The batch with every audit insert passed through the test hook (the identity outside tests). */
  const write = (stmts: Stmt[]) => runBatch(db, stmts.map(s => (s.sql.startsWith('INSERT INTO audit_log') ? hook(s) : s)))
  const row = (id: string) => first<MemberRow>(db, stmt('SELECT * FROM members WHERE id = ?', id))
  const person = async (id: string) => {
    const r = await row(id)
    return r && r.kind === 'person' ? r : null
  }
  const bySubject = (kind: 'person' | 'inhouse', subject: string) => first<MemberRow>(db, stmt('SELECT * FROM members WHERE kind = ? AND subject = ?', kind, subject))

  const personAnswer = (r: MemberRow, requestId: string): { ok: PersonPrincipal } | { refused: SignInRefusal } => {
    if (r.status === 'removed') return { refused: 'removed' }
    if (r.status !== 'active' || r.role === null || r.subject === null) return { refused: 'not_invited' }
    return { ok: { kind: 'person', memberId: r.id, role: r.role, subject: r.subject, requestId } }
  }

  /** Answers from the row bound to this subject, read once more (another request may have bound it first). */
  const answerBySubject = async (signIn: SignIn) => {
    const again = await bySubject('person', signIn.subject)
    return again ? personAnswer(again, signIn.requestId) : ({ refused: 'not_invited' } as const)
  }

  return {
    // ---------- MemberDirectory (W1's interface) ----------

    async resolvePerson(signIn: SignIn): Promise<{ ok: PersonPrincipal } | { refused: SignInRefusal }> {
      const at: At = { actorId: '', requestId: signIn.requestId, nowMs: signIn.nowMs }
      // 1. A person row with this subject.
      const bound = await bySubject('person', signIn.subject)
      if (bound) {
        if (bound.status !== 'invited') return personAnswer(bound, signIn.requestId)
        // Re-invited after removal, the same identity signing in again: restore it.
        const stamp = writeStamp(at.requestId)
        await write([
          stmt("UPDATE members SET status = 'active', rev = rev + 1, req_id = ? WHERE id = ? AND kind = 'person' AND status = 'invited' AND subject = ?", stamp, bound.id, signIn.subject),
          auditInsert({ atMs: at.nowMs, actorId: bound.id, args: { action: 'member.restored', memberId: bound.id }, target: { kind: 'member', id: bound.id }, requestId: at.requestId }, memberGuard(bound.id, stamp)),
        ])
        return answerBySubject(signIn)
      }
      // 4 (first): a subject bound to an Inhouse or service row never signs in on the brand app.
      const other = await first<{ id: string }>(db, stmt("SELECT id FROM members WHERE kind <> 'person' AND subject = ?", signIn.subject))
      if (other) return { refused: 'wrong_kind' }
      const invite = await first<MemberRow>(db, stmt("SELECT * FROM members WHERE kind = 'person' AND status = 'invited' AND email_norm = ?", signIn.email))
      if (!invite) return { refused: 'not_invited' }
      if (invite.subject === null) {
        // 2. Bind the open invite to this subject, once.
        const stamp = writeStamp(at.requestId)
        await write([
          stmt("UPDATE members SET subject = ?, status = 'active', rev = rev + 1, req_id = ? WHERE id = ? AND kind = 'person' AND status = 'invited' AND subject IS NULL", signIn.subject, stamp, invite.id),
          auditInsert({ atMs: at.nowMs, actorId: invite.id, args: { action: 'member.bound', memberId: invite.id }, target: { kind: 'member', id: invite.id }, requestId: at.requestId }, memberGuard(invite.id, stamp)),
        ])
        return answerBySubject(signIn)
      }
      // 3. A re-invite of a removed member, signed in as a new identity: a new member row; the old id stays removed.
      const newId = newMemberId()
      const oldStamp = writeStamp(at.requestId)
      const newStamp = writeStamp(at.requestId)
      await write([
        stmt(
          "UPDATE members SET status = 'removed', removed_at_ms = ?, rev = rev + 1, req_id = ? WHERE id = ? AND kind = 'person' AND status = 'invited' AND subject = ?",
          at.nowMs, oldStamp, invite.id, invite.subject,
        ),
        stmt(
          `INSERT INTO members (id, kind, role, status, name, title, email_norm, subject, created_at_ms, invited_by, req_id)
           SELECT ?, 'person', role, 'active', name, title, email_norm, ?, ?, invited_by, ?
           FROM members WHERE id = ? AND status = 'removed' AND req_id = ?`,
          newId, signIn.subject, at.nowMs, newStamp, invite.id, oldStamp,
        ),
        auditInsert({ atMs: at.nowMs, actorId: newId, args: { action: 'member.bound', memberId: newId, replaces: invite.id }, target: { kind: 'member', id: newId }, requestId: at.requestId }, memberGuard(newId, newStamp)),
      ])
      return answerBySubject(signIn)
    },

    async resolveInhouse(signIn: SignIn): Promise<InhouseIdentity> {
      const found = await bySubject('inhouse', signIn.subject)
      if (found) return { kind: 'inhouse', memberId: found.id, subject: signIn.subject, requestId: signIn.requestId }
      const id = newMemberId()
      const stamp = writeStamp(signIn.requestId)
      // The email's local part stands in for a name until P3 shows the team's names.
      const name = signIn.email.split('@')[0].slice(0, 80) || 'Inhouse team'
      await write([
        stmt(
          `INSERT INTO members (id, kind, role, status, name, email_norm, subject, created_at_ms, req_id)
           SELECT ?, 'inhouse', NULL, 'active', ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM members WHERE kind = 'inhouse' AND subject = ?)`,
          id, name, signIn.email, signIn.subject, signIn.nowMs, stamp, signIn.subject,
        ),
        auditInsert({ atMs: signIn.nowMs, actorId: id, args: { action: 'inhouse.first_sign_in', memberId: id }, target: { kind: 'member', id }, requestId: signIn.requestId }, memberGuard(id, stamp)),
      ])
      const now = await bySubject('inhouse', signIn.subject)
      if (!now) throw new Error('resolveInhouse: no row after the insert')
      return { kind: 'inhouse', memberId: now.id, subject: signIn.subject, requestId: signIn.requestId }
    },

    async serviceMember(name: 'smoke'): Promise<string> {
      const r = await first<{ id: string }>(db, stmt("SELECT id FROM members WHERE kind = 'service' AND service_name = ? AND status = 'active'", name))
      if (!r) throw new Error(`no ${name} service row`)
      return r.id
    },

    async profile(memberId: string): Promise<{ name: string; email: string | null; photoKey: string | null } | null> {
      const r = await row(memberId)
      if (!r) return null
      return { name: r.name ?? FORMER_MEMBER, email: r.email_norm, photoKey: r.photo_key }
    },

    // ---------- the members routes ----------

    /**
     * One page of every person row (invited, active and removed, each with its status; a pseudonymised one under its
     * pseudonym), by id: history names removed people too. The Members page shows the open ones.
     */
    async list(page: { limit: number; afterId: string | null }): Promise<{ items: MemberRecord[]; lastId: string | null }> {
      const rows = await all<MemberRow>(db, stmt(
        `SELECT * FROM members WHERE kind = 'person' AND id > ? ORDER BY id LIMIT ?`, page.afterId ?? '', page.limit + 1,
      ))
      const more = rows.length > page.limit
      const items = rows.slice(0, page.limit).map(memberRecord)
      return { items, lastId: more ? items[items.length - 1].id : null }
    },

    async get(id: string): Promise<MemberRecord | null> {
      const r = await person(id)
      return r && memberRecord(r)
    },

    /** Invite: 409 `already_member` while an open row has the email; else re-invite the latest removed row, or a new one. */
    async invite(input: InviteInput, at: At): Promise<{ ok: MemberRecord; reinvited: boolean } | { refused: 'already_member' }> {
      const email = input.email.trim().toLowerCase()
      const removed = await first<{ id: string }>(db, stmt(
        "SELECT id FROM members WHERE kind = 'person' AND status = 'removed' AND email_norm = ? AND pseudonymised_at_ms IS NULL ORDER BY removed_at_ms DESC, id DESC LIMIT 1",
        email,
      ))
      let id: string
      let results: D1Result[]
      if (removed) {
        id = removed.id
        results = await write(reinviteStmts(id, input, at))
      } else {
        const built = newInviteStmts(input, at)
        id = built.id
        try {
          results = await write(built.stmts)
        } catch (err) {
          // The partial unique index: a concurrent invite for the same email won the insert.
          if (err instanceof Error && /UNIQUE constraint failed/.test(err.message)) return { refused: 'already_member' }
          throw err
        }
      }
      if (results[0].meta.changes === 0) return { refused: 'already_member' }
      const r = await person(id)
      if (!r) throw new Error('invite: no row after the write')
      return { ok: memberRecord(r), reinvited: removed !== null }
    },

    /** A role change. Demoting needs another active Admin, checked in the statement. */
    async changeRole(input: { id: string; role: MemberRole; ifRev: number }, at: At): Promise<Outcome<MemberRecord, 'not_found' | 'last_admin' | 'unchanged'>> {
      const from: MemberRole = input.role === 'admin' ? 'member' : 'admin'
      const stamp = writeStamp(at.requestId)
      const [change] = await write([
        stmt(
          `UPDATE members SET role = ?, rev = rev + 1, req_id = ?
           WHERE id = ? AND rev = ? AND kind = 'person' AND ${OPEN} AND role = ?
             AND (? = 'admin' OR status <> 'active' OR ${ANOTHER_ADMIN})`,
          input.role, stamp, input.id, input.ifRev, from, input.role, input.id,
        ),
        auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'member.role_changed', memberId: input.id, from, to: input.role }, target: { kind: 'member', id: input.id }, requestId: at.requestId }, memberGuard(input.id, stamp)),
      ])
      const r = await person(input.id)
      if (change.meta.changes > 0 && r) return { ok: memberRecord(r) }
      if (!r || r.status === 'removed') return { refused: 'not_found' }
      if (r.rev !== input.ifRev) return { conflict: memberRecord(r) }
      if (r.role === input.role) return { refused: 'unchanged' }
      return { refused: 'last_admin' }
    },

    /**
     * Removal: never the last active Admin, checked in the statement. `notAdmin` (the Inhouse team, decision 19b): never
     * an Admin at all, also in the statement, so a role change racing the removal can't slip an Admin through.
     */
    async remove(input: { id: string; ifRev: number; notAdmin?: boolean }, at: At): Promise<Outcome<MemberRecord, 'not_found' | 'last_admin' | 'admin_target'>> {
      const stamp = writeStamp(at.requestId)
      const [change] = await write([
        stmt(
          `UPDATE members SET status = 'removed', removed_at_ms = ?, rev = rev + 1, req_id = ?
           WHERE id = ? AND rev = ? AND kind = 'person' AND ${OPEN}
             AND (role <> 'admin' OR status <> 'active' OR ${ANOTHER_ADMIN})
             AND (? = 0 OR role <> 'admin')`,
          at.nowMs, stamp, input.id, input.ifRev, input.id, input.notAdmin ? 1 : 0,
        ),
        auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'member.removed', memberId: input.id }, target: { kind: 'member', id: input.id }, requestId: at.requestId }, memberGuard(input.id, stamp)),
      ])
      const r = await person(input.id)
      if (change.meta.changes > 0 && r) return { ok: memberRecord(r) }
      if (!r || r.status === 'removed') return { refused: 'not_found' }
      if (r.rev !== input.ifRev) return { conflict: memberRecord(r) }
      if (input.notAdmin && r.role === 'admin') return { refused: 'admin_target' }
      return { refused: 'last_admin' }
    },

    /** `g:name`: the display name on the member's own row. `audit` is the line's arguments (the name redacted). */
    async rename(input: { id: string; name: string; ifRev: number; audit: { len: number; hash: string } }, at: At): Promise<Outcome<MemberRow, 'not_found'>> {
      const stamp = writeStamp(at.requestId)
      const [change] = await write([
        stmt(
          "UPDATE members SET name = ?, rev = rev + 1, req_id = ? WHERE id = ? AND rev = ? AND kind = 'person' AND pseudonymised_at_ms IS NULL AND status <> 'removed'",
          input.name, stamp, input.id, input.ifRev,
        ),
        auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'setting.changed', scope: 'personal', key: 'g:name', redacted: input.audit }, target: { kind: 'setting', id: 'g:name' }, requestId: at.requestId }, memberGuard(input.id, stamp)),
      ])
      const r = await person(input.id)
      if (change.meta.changes > 0 && r) return { ok: r }
      if (!r || r.status === 'removed' || r.pseudonymised_at_ms !== null) return { refused: 'not_found' }
      return { conflict: r }
    },

    /** The member row behind a person's personal settings (its name is `g:name`). */
    row,

    /**
     * P8's person deletion (no route until then): the row keeps its id and becomes "Former member"; title, email,
     * photo key and Access subject go (the identity can be invited again as someone new); the audit log is untouched (decision Q3). Never the last active Admin. Writes no audit line.
     */
    async pseudonymise(id: string, at: At): Promise<{ ok: MemberRecord } | { refused: 'not_found' | 'last_admin' }> {
      const stamp = writeStamp(at.requestId)
      const [change] = await runBatch(db, [stmt(
        `UPDATE members SET name = ?, title = NULL, email_norm = NULL, photo_key = NULL, subject = NULL, status = 'removed',
           removed_at_ms = COALESCE(removed_at_ms, ?), pseudonymised_at_ms = ?, rev = rev + 1, req_id = ?
         WHERE id = ? AND kind = 'person' AND pseudonymised_at_ms IS NULL
           AND (role <> 'admin' OR status <> 'active' OR ${ANOTHER_ADMIN})`,
        FORMER_MEMBER, at.nowMs, at.nowMs, stamp, id, id,
      )])
      const r = await person(id)
      if (!r) return { refused: 'not_found' }
      if (change.meta.changes > 0) return { ok: memberRecord(r) }
      return r.pseudonymised_at_ms !== null ? { refused: 'not_found' } : { refused: 'last_admin' }
    },
  }
}

export type MemberStore = ReturnType<typeof memberStore>
