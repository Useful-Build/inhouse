// Brand skills (P6a, master plan standing decision 6; 0471_brand_skills.sql). Each write is one batch: the row's
// statement, with every rule that can race in its own WHERE (who may change it, its rev, the brand's 25 skills and
// 192 KiB), then its audit line guarded on the row this very write stamped, so a refused write changes nothing and
// writes no line. The audit detail holds the skill's id only, never its name, description or instructions.
//
// Who may change or delete a skill: the person who made it, or an admin (read from `members` in the same statement, so
// a role change can't race the write). Once the maker's personal data is deleted (`created_by` cleared to NULL), only
// an active admin can change or delete the skill. Saving needs a person: a routine's own run (`m_system`) is refused by the tool.
import {
  BRAND_SKILLS_BYTES_MAX, BRAND_SKILLS_MAX, BrandSkillFile, brandSkillBodyProblem, brandSkillBytes, brandSkillDescriptionProblem, brandSkillNameProblem, cleanBody,
} from '../../shared/protocol/brand-skills.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { writeStamp } from '../db/ids.ts'

export interface BrandSkillRow {
  id: string
  name: string
  description: string
  body: string
  created_by: string | null
  created_at_ms: number
  updated_by: string | null
  updated_at_ms: number
  rev: number
  req_id: string | null
}

/** A row with its maker's name (null when the member row has none, or was pseudonymised). */
export type BrandSkillListed = BrandSkillRow & { creator_name: string | null }

export interface At { actorId: string; requestId: string; nowMs: number }
export interface SkillInput { name: string; description: string; body: string }

export type SaveOutcome =
  | { ok: BrandSkillRow; created: boolean }
  | { refused: 'invalid'; why: string }
  | { refused: 'inactive' | 'not_owner' | 'limit' | 'too_large' | 'conflict' }
export type DeleteOutcome = { ok: BrandSkillRow } | { conflict: BrandSkillRow } | { refused: 'not_found' | 'not_owner' }

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
/** `bs_` + 128 random bits (the audit contract's `BrandSkillIdSchema`). */
export const newBrandSkillId = (): string => `bs_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** The UTF-8 bytes a row counts against the budget, in SQL (the same sum as `brandSkillBytes`). */
const ROW_BYTES = 'length(CAST(name AS BLOB)) + length(CAST(description AS BLOB)) + length(CAST(body AS BLOB))'
/** The maker, or an admin who is still on the team. Binds the actor's id twice. */
const MAY_CHANGE = `(created_by = ? OR EXISTS (SELECT 1 FROM members WHERE id = ? AND kind = 'person' AND role = 'admin' AND status = 'active'))`
const ACTIVE_PERSON = `EXISTS (SELECT 1 FROM members WHERE id = ? AND kind = 'person' AND status = 'active' AND pseudonymised_at_ms IS NULL)`
const isActivePerson = (db: SkillDatabase, actorId: string) => db.prepare(`SELECT 1 WHERE ${ACTIVE_PERSON}`).bind(actorId).first()

export interface SkillQueryResult<T = unknown> {
  results: T[]
  meta: { changes: number }
}
export interface SkillStatement {
  bind(...values: unknown[]): SkillStatement
  first<T = Record<string, unknown>>(): Promise<T | null>
  all<T = Record<string, unknown>>(): Promise<SkillQueryResult<T>>
}
/** The portion of D1 used by the store, also supplied by the sandbox eval harness. */
export interface SkillDatabase {
  prepare(sql: string): SkillStatement
  batch(statements: SkillStatement[]): Promise<SkillQueryResult[]>
}

/** The input as kept (trimmed name and description, the body cleaned), or why it can't be. */
export function checkSkill(i: SkillInput): { ok: SkillInput } | { why: string } {
  const name = i.name.trim()
  const description = i.description.trim()
  const body = cleanBody(i.body)
  const why = brandSkillNameProblem(name) ?? brandSkillDescriptionProblem(description) ?? brandSkillBodyProblem(body)
  return why === null ? { ok: { name, description, body } } : { why }
}

const readByName = (db: SkillDatabase, name: string): Promise<BrandSkillRow | null> => db.prepare('SELECT * FROM brand_skills WHERE name = ?').bind(name).first<BrandSkillRow>()
const readById = (db: SkillDatabase, id: string): Promise<BrandSkillRow | null> => db.prepare('SELECT * FROM brand_skills WHERE id = ?').bind(id).first<BrandSkillRow>()

function auditStmt(db: SkillDatabase, at: At, args: AuditArgs, id: string, stamp: string): SkillStatement {
  const s = auditInsert({ atMs: at.nowMs, actorId: at.actorId, args, target: { kind: 'brand_skill', id }, requestId: at.requestId }, { table: 'brand_skills', where: 'id = ?', params: [id], stamp })
  return db.prepare(s.sql).bind(...s.params)
}

const written = (r: SkillQueryResult, what: string): BrandSkillRow => {
  const row = (r.results as BrandSkillRow[] | undefined)?.[0]
  if (!row) throw new Error(`${what}: the write returned no row`)
  return row
}

/** The brand's skills by name, each with its maker's name (null once cleared or pseudonymised). */
export async function listSkills(db: SkillDatabase): Promise<BrandSkillListed[]> {
  const res = await db.prepare(
    `SELECT s.*, CASE WHEN m.pseudonymised_at_ms IS NULL THEN m.name END AS creator_name FROM brand_skills s LEFT JOIN members m ON m.id = s.created_by ORDER BY s.name LIMIT ?`,
  ).bind(BRAND_SKILLS_MAX).all<BrandSkillListed>()
  return res.results
}

/** One skill by name, with its maker's name (null once cleared or pseudonymised), or null. */
export const getSkill = (db: SkillDatabase, name: string): Promise<BrandSkillListed | null> =>
  db.prepare('SELECT s.*, CASE WHEN m.pseudonymised_at_ms IS NULL THEN m.name END AS creator_name FROM brand_skills s LEFT JOIN members m ON m.id = s.created_by WHERE s.name = ?').bind(name).first<BrandSkillListed>()

/** What a run's start carries: each valid skill, by name. */
export async function skillFiles(db: SkillDatabase): Promise<BrandSkillFile[]> {
  const res = await db.prepare('SELECT id, name, description, body FROM brand_skills ORDER BY name LIMIT ?').bind(BRAND_SKILLS_MAX).all<Pick<BrandSkillRow, 'id' | 'name' | 'description' | 'body'>>()
  const files: BrandSkillFile[] = []
  for (const { id, name, description, body } of res.results) {
    const file = BrandSkillFile.safeParse({ name, description, body })
    if (file.success) files.push(file.data)
    else console.warn({ event: 'brand_skill_invalid', skillId: id })
  }
  return files
}

/**
 * Saves a skill by name: a new name makes one (if the brand has room), an existing name changes it (if the actor may).
 * Live at once: there is no approval step (standing decision 6).
 */
export async function saveSkill(db: SkillDatabase, input: SkillInput, at: At, { createOnly = false } = {}): Promise<SaveOutcome> {
  const checked = checkSkill(input)
  if ('why' in checked) return { refused: 'invalid', why: checked.why }
  const s = checked.ok
  const bytes = brandSkillBytes(s)
  const before = await readByName(db, s.name)
  if (before && createOnly) return { refused: 'conflict' }
  const stamp = writeStamp(at.requestId)
  if (!before) {
    const id = newBrandSkillId()
    const [made] = await db.batch([
      db.prepare(
        `INSERT INTO brand_skills (id, name, description, body, created_by, created_at_ms, updated_by, updated_at_ms, rev, req_id)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
          WHERE NOT EXISTS (SELECT 1 FROM brand_skills WHERE name = ?)
            AND ${ACTIVE_PERSON}
            AND (SELECT count(*) FROM brand_skills) < ?
            AND (SELECT COALESCE(SUM(${ROW_BYTES}), 0) FROM brand_skills) + ? <= ? RETURNING *`,
      ).bind(id, s.name, s.description, s.body, at.actorId, at.nowMs, at.actorId, at.nowMs, stamp, s.name, at.actorId, BRAND_SKILLS_MAX, bytes, BRAND_SKILLS_BYTES_MAX),
      auditStmt(db, at, { action: 'brand_skill.created', skillId: id }, id, stamp),
    ])
    if (made.meta.changes > 0) return { ok: written(made, 'saveSkill'), created: true }
    if (!(await isActivePerson(db, at.actorId))) return { refused: 'inactive' }
    // The same name raced this one in (the caller saves again to change it), or the brand is full.
    if (await readByName(db, s.name)) return { refused: 'conflict' }
    const { n } = (await db.prepare('SELECT count(*) AS n FROM brand_skills').first<{ n: number }>())!
    return { refused: n >= BRAND_SKILLS_MAX ? 'limit' : 'too_large' }
  }
  const [changed] = await db.batch([
    db.prepare(
      `UPDATE brand_skills SET description = ?, body = ?, updated_by = ?, updated_at_ms = ?, rev = rev + 1, req_id = ?
        WHERE id = ? AND rev = ? AND ${MAY_CHANGE} AND ${ACTIVE_PERSON}
          AND (SELECT COALESCE(SUM(${ROW_BYTES}), 0) FROM brand_skills WHERE id != ?) + ? <= ? RETURNING *`,
    ).bind(s.description, s.body, at.actorId, at.nowMs, stamp, before.id, before.rev, at.actorId, at.actorId, at.actorId, before.id, bytes, BRAND_SKILLS_BYTES_MAX),
    auditStmt(db, at, { action: 'brand_skill.changed', skillId: before.id }, before.id, stamp),
  ])
  if (changed.meta.changes > 0) return { ok: written(changed, 'saveSkill'), created: false }
  // Refused: a departed actor first, then a change that came in meanwhile, ownership and size.
  if (!(await isActivePerson(db, at.actorId))) return { refused: 'inactive' }
  const now = await readById(db, before.id)
  if (!now || now.rev !== before.rev) return { refused: 'conflict' }
  const may = await db.prepare(`SELECT 1 AS ok FROM brand_skills WHERE id = ? AND ${MAY_CHANGE}`).bind(before.id, at.actorId, at.actorId).first()
  return { refused: may ? 'too_large' : 'not_owner' }
}

/**
 * Deletes a skill at the rev last read, if the actor made it or is an admin. Three statements in one batch: stamp the
 * row (every rule in its WHERE), write the line guarded on that stamp, then delete the stamped row.
 */
export async function deleteSkill(db: SkillDatabase, i: { id: string; ifRev: number }, at: At): Promise<DeleteOutcome> {
  const stamp = writeStamp(at.requestId)
  const [stamped] = await db.batch([
    db.prepare(`UPDATE brand_skills SET req_id = ? WHERE id = ? AND rev = ? AND ${MAY_CHANGE} RETURNING *`).bind(stamp, i.id, i.ifRev, at.actorId, at.actorId),
    auditStmt(db, at, { action: 'brand_skill.deleted', skillId: i.id }, i.id, stamp),
    db.prepare('DELETE FROM brand_skills WHERE id = ? AND req_id = ?').bind(i.id, stamp),
  ])
  if (stamped.meta.changes > 0) return { ok: written(stamped, 'deleteSkill') }
  // Refused: an unknown id first, then who may delete it, then the row as it is now.
  const row = await readById(db, i.id)
  if (!row) return { refused: 'not_found' }
  const may = await db.prepare(`SELECT 1 AS ok FROM brand_skills WHERE id = ? AND ${MAY_CHANGE}`).bind(i.id, at.actorId, at.actorId).first()
  if (!may) return { refused: 'not_owner' }
  return { conflict: row }
}

/** The D1 stores' slot (server/db/stores.ts). */
export function brandSkillStore({ db }: { db: SkillDatabase }) {
  return {
    list: () => listSkills(db),
    get: (name: string) => getSkill(db, name),
    files: () => skillFiles(db),
    save: (i: SkillInput, at: At) => saveSkill(db, i, at),
    remove: (i: { id: string; ifRev: number }, at: At) => deleteSkill(db, i, at),
  }
}
export type BrandSkillStore = ReturnType<typeof brandSkillStore>
