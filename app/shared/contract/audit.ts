// The audit log: changes to how the agent may work. W2 owns this file in P2 (its actions and the `AuditEntry` it becomes).
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { pageOf } from './paging.ts'
import { GrantHoursSchema, GrantIdSchema } from './grants.ts'
import { RunIdSchema } from './chat-ids.ts'
import { MemberIdSchema, MemberRoleSchema } from './members.ts'
import { SettingKeySchema, SettingScopeSchema, SettingValueSchema, settingSpec } from './settings.ts'

export const AuditEntrySchema = z.object({ at: InstantSchema, who: z.string(), what: z.string(), detail: z.string() })
export type AuditEntry = z.infer<typeof AuditEntrySchema>

// ---------- P2: the audit log the product keeps (p2-design.md section 8, decision Q3). `AuditEntrySchema` stays until W3 switches data.ts over. ----------

/** Every action the log records. Closed: a new one is a contract change. */
export const AuditActionSchema = z.enum([
  'member.invited', 'member.reinvited', 'member.bound', 'member.restored', 'member.role_changed', 'member.removed',
  'inhouse.first_sign_in', 'setting.changed', 'photo.changed', 'photo.removed', 'grant.created', 'grant.ended',
  'grant.expired', 'support.access',
  // P3 (p3-design sections 3, 4.10 and 4.11): an Admin's or the Inhouse team's pause and resume, and an Inhouse socket attach.
  'agent.paused', 'agent.resumed', 'support.attach',
  // P3 (p3-design section 10, item 19): an Admin or the Inhouse team (under a live grant) forgets a team fact, or undoes that.
  'memory.forgotten', 'memory.restored',
  // P3 W1 PR 6 (route 51): the release job revived one quarantined due task (P4's and P6's runbooks).
  'ops_task_revive',
])
export type AuditAction = z.infer<typeof AuditActionSchema>

/** A value the log may not hold as it is: its length and the first 16 bytes of its HMAC-SHA-256 under `AUDIT_HASH_KEY`, hex. */
export const RedactedValueSchema = z.object({ len: z.number().int().min(0), hash: z.string().regex(/^[0-9a-f]{32}$/) }).strict()

/** The pattern of a `brand_data` GET route (p2-design.md section 3), never a concrete path: no ids, query, names or emails. */
const RoutePatternSchema = z.enum([
  '/api/members', '/api/members/:id/photo', '/api/audit', '/api/audit/export.csv',
  // P3's brand_data GET routes (p3-design section 3: rows 22, 24, 32, 33, 34, 40, 41, 43).
  '/api/chats', '/api/chats/:id', '/api/runs/active', '/api/traces/:id', '/api/socket', '/api/chats/:id/files',
  '/api/files/:fileId', '/api/memory',
])
/**
 * The `brand_data` write routes the Inhouse team may use under a live grant (item 19, p3-design section 10): forgetting
 * a team fact. `support.access` pairs `PUT` with these only, and `GET` with `RoutePatternSchema` only.
 */
const WritePatternSchema = z.enum(['/api/memory/brand/:id/forgotten'])
const MemoryIdArgSchema = z.string().regex(/^mem_[A-Za-z0-9_-]{22}$/)
const PhotoTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])
/**
 * A due task's kind and id as route 51 takes them: ids the server makes, never a name, an email or a text. An id is a
 * kind-shaped seed id (`outbox-sweep`) or `<kind-shaped prefix>:<server id>` (`deferred-hook:q_...`).
 */
export const TaskKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const TaskIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}(:[A-Za-z0-9_:.-]{1,200})?$/)
export const ReviveResultSchema = z.enum(['revived', 'not_quarantined', 'not_found'])

const line = <A extends AuditAction, S extends z.ZodRawShape>(action: A, shape: S) => z.object({ action: z.literal(action), ...shape }).strict()
const member = { memberId: MemberIdSchema }

/** `setting.changed` as stored: the shape only. The registry's checks (below) run when a line is written. */
const settingChanged = line('setting.changed', {
  scope: SettingScopeSchema,
  key: SettingKeySchema,
  value: SettingValueSchema.nullable().optional(),
  redacted: RedactedValueSchema.optional(),
})

const otherLines = [
  line('member.invited', { ...member, role: MemberRoleSchema }),
  line('member.reinvited', { ...member, role: MemberRoleSchema }),
  /** `replaces`: the removed row of an earlier identity the invite was on (a re-invite that signed in as someone new). */
  line('member.bound', { ...member, replaces: MemberIdSchema.optional() }),
  line('member.restored', member),
  line('member.role_changed', { ...member, from: MemberRoleSchema, to: MemberRoleSchema }),
  line('member.removed', member),
  line('inhouse.first_sign_in', member),
  line('photo.changed', { type: PhotoTypeSchema, size: z.number().int().min(1).max(1024 * 1024) }),
  line('photo.removed', {}),
  line('grant.created', { grantId: GrantIdSchema, hours: GrantHoursSchema }),
  line('grant.ended', { grantId: GrantIdSchema }),
  line('grant.expired', { grantId: GrantIdSchema }),
  line('support.access', { grantId: GrantIdSchema, method: z.enum(['GET', 'PUT']), route: z.union([RoutePatternSchema, WritePatternSchema]) })
    .superRefine((a, ctx) => {
      // Runs even when a field above failed (zod 4), so it checks each value's type before using it.
      const pattern = a.method === 'GET' ? RoutePatternSchema : a.method === 'PUT' ? WritePatternSchema : null
      if (pattern && !pattern.safeParse(a.route).success) ctx.addIssue({ code: 'custom', path: ['route'], message: 'Not a route for this method' })
    }),
  line('agent.paused', {}),
  line('agent.resumed', {}),
  /** An Inhouse socket attach to a run, written before any of its frames are sent (p3-design 4.10). */
  line('support.attach', { grantId: GrantIdSchema, runId: RunIdSchema }),
  /** A team fact forgotten, or that undone (it then waits for an admin's OK again). Ids only, never the fact's text. */
  line('memory.forgotten', { memoryId: MemoryIdArgSchema }),
  line('memory.restored', { memoryId: MemoryIdArgSchema }),
  /** Route 51: one due task revived (or found not quarantined, or not there), by the release job. */
  line('ops_task_revive', { kind: TaskKindSchema, id: TaskIdSchema, result: ReviveResultSchema }),
] as const

/**
 * A line's arguments, one shape per action, as the writer checks them. People are named by member id only; no field
 * holds a name, an email, a token, a secret or photo bytes. A setting reset to its default records `value: null` for
 * any key (a reset holds nothing personal). Any other value is kept as it is only for a key the registry marks
 * audit-safe; a key that isn't keeps the value's length and hash in `redacted` instead.
 */
export const AuditArgsSchema = z.discriminatedUnion('action', [
  settingChanged.superRefine((a, ctx) => {
    const spec = settingSpec(a.key)
    if (!spec) return void ctx.addIssue({ code: 'custom', path: ['key'], message: 'Not a setting' })
    if (spec.scope !== a.scope) ctx.addIssue({ code: 'custom', path: ['scope'], message: "Not this key's scope" })
    if (a.value === null) {
      if (a.redacted !== undefined) ctx.addIssue({ code: 'custom', path: ['redacted'], message: 'A reset keeps no length or hash' })
    } else if (spec.auditSafe) {
      if (a.redacted !== undefined || a.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: 'An audit-safe key keeps its value' })
      else if (!spec.value.safeParse(a.value).success) ctx.addIssue({ code: 'custom', path: ['value'], message: "Not this key's value" })
    } else if (a.value !== undefined || a.redacted === undefined) {
      ctx.addIssue({ code: 'custom', path: ['redacted'], message: 'This key keeps only its length and hash' })
    }
  }),
  ...otherLines,
])

/**
 * A stored line's arguments as a reader parses them: the same shapes, without the registry's checks, so a line written
 * under an older registry (a key since removed, or no longer audit-safe) still reads. What a reader shows of a value is
 * decided against the registry as it is now (shared/audit-text.ts).
 */
export const StoredAuditArgsSchema = z.discriminatedUnion('action', [settingChanged, ...otherLines])

export type AuditArgs = z.infer<typeof AuditArgsSchema>

/**
 * A line as the audit page and the CSV show it: `who` is the actor's current name ("Former member" once pseudonymised),
 * `what` and `detail` come from the action and its arguments (app/shared/audit-text.ts). `id` orders the log, newest highest.
 */
export const AuditLineSchema = z.object({
  id: z.number().int().positive(),
  at: InstantSchema,
  actorId: MemberIdSchema,
  who: z.string(),
  what: z.string(),
  detail: z.string(),
})
export type AuditLine = z.infer<typeof AuditLineSchema>

/** `GET /api/audit?cursor&limit`: a page of lines, newest first. */
export const AuditPageSchema = pageOf(AuditLineSchema)
export type AuditPage = z.infer<typeof AuditPageSchema>
