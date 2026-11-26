// The audit log records changes to how the agent may work.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { pageOf } from './paging.ts'
import { GrantHoursSchema, GrantIdSchema } from './grants.ts'
import { FileIdSchema, RunIdSchema } from './chat-ids.ts'
import { MemberIdSchema, MemberRoleSchema } from './members.ts'
import { ActionChoiceSchema, ActionIdSchema, ActionResolutionSchema } from './actions.ts'
import { GuardrailSchema, PermissionIdSchema } from './permissions.ts'
import { QuestionIdSchema } from './questions.ts'
import type { WriteOperationKey } from '../../hub/index/contract.ts'
import { SettingKeySchema, SettingScopeSchema, SettingValueSchema, settingSpec } from './settings.ts'

/** An audit row formatted for display, also used by the demo. */
export const AuditEntrySchema = z.object({ at: InstantSchema, who: z.string(), what: z.string(), detail: z.string() })
export type AuditEntry = z.infer<typeof AuditEntrySchema>

// The product audit API returns paginated records with typed actions and details.

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
  // P4 (p4-orchestrator.md section 2, wave-4 PR0): routines (W2), the Library (W5) and Today's set-aside (W3). The
  // actor is the member who acted. P5 appends its own block after this one.
  'routine.created', 'routine.updated', 'routine.enabled', 'routine.deleted', 'routine.restored', 'routine.run_now',
  'library.uploaded', 'library.deleted', 'library.restored',
  'today.set_aside',
  // P5 (p5-w1): the Inhouse team starts connecting a tool, and how the connect ended.
  'tools.connect_start', 'tools.connect',
  // P5 (p5-w3): the Inhouse team pauses, resumes or disconnects a tool.
  'tools.pause', 'tools.disconnect',
  // P5 (p5-w4): a notice to one recipient (the agent's or the server's own), and a change to the listed Slack channels.
  'notify.send', 'notify.channels',
  // P8a R: an admin confirmed a restore once its audit re-append and deletion-log replay were done (ops/backup/reconcile).
  'restore.confirmed',
  // P8a R: the restore's audit re-append put back a pseudonymised member row for an actor added after the backup.
  'restore.member_placeholder',
  // P8a F2: a Shopify privacy webhook arrived (Shopify's signature checked), and the release job closed one once the
  // Inhouse team had acted on it. Our request id and the topic only: never a Shopify customer id, email or phone.
  'privacy.requested', 'privacy.closed',
  // P6a (PR0, docs/plans/2026-11-22-p6a-memory-skills.md): an admin, or the Inhouse team under a live grant, approves
  // or rejects a waiting team fact (W2); a person sends the Inhouse team a request, and its status changes (W3).
  'memory.approved', 'memory.rejected', 'team_request.created', 'team_request.status',
  // P6a brand skills (master plan standing decision 6): a person's agent saves a brand skill (new or changed), and its
  // maker or an admin deletes it.
  'brand_skill.created', 'brand_skill.changed', 'brand_skill.deleted',
  // P8a D (route 95): an Admin, or the Inhouse team under a live grant, downloaded the brand's whole export.
  'data.exported',
  // Stage 1 M2 (N18; M2-A defines them all, the outbox and the questions write most): a permission ("Always allow")
  // made or revoked; an action the agent proposed, through its whole life; a question to a person.
  'permission.granted', 'permission.revoked',
  'action.requested', 'action.answered', 'action.undone', 'action.withdrawn', 'action.lapsed', 'action.sent', 'action.failed',
  'action.needs_check', 'action.resolved',
  'question.asked', 'question.answered', 'question.expired',
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
  // P4's brand_data GET routes (Sonnet M-4): the Routines page, Today, Activity and the Library, so Inhouse under a live
  // grant gets data, not 503 ("no line, no data").
  '/api/routines', '/api/today', '/api/activity', '/api/library', '/api/library/:id/download',
  // P6a (PR0, route 77): the waiting team facts, admins and the Inhouse team under a live grant.
  '/api/memory/waiting',
  // P6a brand skills (route 84): a skill's full text is brand data (the list, route 79, is technical and needs no grant).
  '/api/skills/:name',
  // Master plan decision 8 (route 86): a routine's recent runs.
  '/api/routines/:id/runs',
  // P8a D (route 95): Export everything; (route 96) its check.
  '/api/data-access/export', '/api/data-access/export/check',
])
/**
 * The `brand_data` PUT routes the Inhouse team may use under a live grant (item 19, p3-design section 10): forgetting
 * a team fact; P4: turning a routine on or off and setting aside an item on Today; P6a: approving or rejecting a
 * waiting team fact. `support.access` pairs `PUT` with
 * these only, `POST` with `PostPatternSchema` only and `GET` with `RoutePatternSchema` only.
 */
const WritePatternSchema = z.enum([
  '/api/memory/brand/:id/forgotten',
  // P4 (routes.ts rows 53 and 58).
  '/api/routines/:id/enabled', '/api/today/:id/aside',
  // P6a (PR0, route 78): approving or rejecting a waiting team fact.
  '/api/memory/brand/:id/approved',
])
/**
 * The `brand_data` POST routes the Inhouse team may use under a live grant, one block per phase, appended in phase
 * order (P6 adds `/api/approvals/:id/check` after P4's). P4: a routine's Run now, delete and restore (routes.ts rows
 * 54 to 56) and the Library's delete and restore (rows 65 and 66; the upload is people only).
 */
const PostPatternSchema = z.enum([
  // P4.
  '/api/routines/:id/run', '/api/routines/:id/delete', '/api/routines/:id/restore', '/api/library/delete', '/api/library/restore',
])
const MemoryIdArgSchema = z.string().regex(/^mem_[A-Za-z0-9_-]{22}$/)
const PhotoTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])
/**
 * A due task's kind and id as route 51 takes them: ids the server makes, never a name, an email or a text. An id is a
 * kind-shaped seed id (`outbox-sweep`) or `<kind-shaped prefix>:<server id>` (`deferred-hook:q_...`). A bare lowercase
 * word also matches the seed shape: "ids only" rests on route 51 being release-only (the release job sends task ids).
 */
export const TaskKindSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
export const TaskIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}(:[A-Za-z0-9_:.-]{1,200})?$/)
export const ReviveResultSchema = z.enum(['revived', 'not_quarantined', 'not_found'])

// ---------- P4's argument shapes (ids the server makes, counts and closed lists; never a name or a text) ----------
/** 128 random bits as base64url without padding: 22 characters (chat-ids.ts's rule). */
const RANDOM = '[A-Za-z0-9_-]{22}'
/** A routine: `rt_` + 128 random bits (a team routine), or a system routine's fixed id (`routine-morning-check`). */
const ROUTINE_ID = `(?:rt_${RANDOM}|routine-[a-z0-9]+(?:-[a-z0-9]+){0,7})`
export const RoutineIdSchema = z.string().regex(new RegExp(`^${ROUTINE_ID}$`))
/**
 * A routine slot (p4-w2.md section 1): `<routineId>|<YYYY-MM-DD>|<HH:MM>` for a scheduled one, `now|<routineId>|<clientKey>`
 * for a Run now (`clientKey` the client's turn key shape, runs.ts).
 */
export const SlotKeySchema = z.string().regex(new RegExp(`^(?:${ROUTINE_ID}\\|\\d{4}-\\d{2}-\\d{2}\\|\\d{2}:\\d{2}|now\\|${ROUTINE_ID}\\|[A-Za-z0-9_-]{8,64})$`))
/** What a routine edit changed (never the new text). */
export const RoutineChangeSchema = z.enum(['instruction', 'schedule', 'missed'])
/**
 * A Today item (p4-w3.md sections 3 and 5): `p_` + a 22-character hash of the problem key and date, or a status card's
 * `p_check_<local date>_<cause>_<hash>` (the slot key's hash; a `not_run` or an `off` card has no slot, so it hashes
 * `<routineId>|<local date>`). One tail shape for every cause.
 */
export const TodayItemIdSchema = z.string().regex(new RegExp(`^p_(?:${RANDOM}|check_\\d{4}-\\d{2}-\\d{2}_(?:incomplete|failed|not_run|not_connected|off)_[A-Za-z0-9_-]{8,43})$`))
/**
 * P3's chat file type list (server/files-io/caps.ts `FILE_CAPS.allowedTypes`; audit.test.ts keeps the two equal): the
 * sniffer's type of a Library upload. HTML and SVG are never here.
 */
export const LibraryTypeSchema = z.enum([
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv', 'text/plain', 'text/markdown', 'application/json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])
/** P3's chat file cap (20 MiB, caps.ts `maxFileBytes`). */
const LIBRARY_MAX_BYTES = 20_971_520
const FileIdsSchema = z.array(FileIdSchema).min(1).max(100)
// P5 (p5-w1): a connector account and how a connect ended. W3's audit block reuses both.
/** The hub's account id (H0's pattern, app/hub/index/schemas.ts `ACCOUNT_ID`): `slack:workspace`, `shopify:store`. */
export const ConnectorAccountIdSchema = z.string().regex(/^[a-z]+(:[a-z0-9-]{1,40})?$/)
/** `ok`, or one of the hub's closed error codes (app/hub/index/contract.ts `HubErrorCode`), never upstream text. */
export const ConnectOutcomeSchema = z.enum([
  'ok', 'invalid_args', 'unknown_tool', 'write_refused', 'not_configured', 'credentials_rejected', 'scope_mismatch',
  'key_unavailable', 'upstream_unavailable', 'upstream_rejected', 'upstream_version_mismatch', 'rate_limited',
  'result_too_large', 'internal', 'state_invalid', 'workspace_mismatch', 'connect_stale', 'connect_refused', 'paused',
])
export type ConnectOutcome = z.infer<typeof ConnectOutcomeSchema>
// P5 (p5-w4): notices. Ids, closed codes, a length and a hash only; never the notice's text, a title or a name.
export const NotifySourceSchema = z.enum(['agent', 'approvals', 'questions', 'routines'])
/** The server's own notice kinds (p5-w4 section 3a); `question_asked` is stored as `question_waiting`. */
export const SystemNoticeKindSchema = z.enum([
  'approval_waiting', 'approval_lapsed', 'approval_sent', 'approval_failed', 'needs_check', 'approval_expired',
  'restore_reconciled', 'question_waiting', 'question_closed',
])
/** A public Slack channel id (never `U…`, `D…` or `G…`). */
export const SlackChannelIdSchema = z.string().regex(/^C[A-Z0-9]{8,}$/)
/** `posted`: delivered (a Slack post, or a bell notice written); `unknown`: the hub call threw after the reservation. */
export const NotifyOutcomeSchema = z.enum(['posted', 'refused', 'failed', 'unknown'])
/** Why a recipient didn't get it, or where it went instead: a closed list, never upstream text. */
export const NotifyDetailSchema = z.enum([
  'not_listed', 'shared_channel', 'archived', 'not_public', 'not_member', 'not_found', 'run_cap', 'day_cap', 'too_long',
  'empty', 'unknown_member', 'slack_not_connected', 'slack_unavailable', 'rate_limited', 'to_bell', 'no_alerts_channel', 'below_act',
  // The hub's APP_ORIGIN is unset or malformed, so a post carrying the app link is refused (review round 1).
  'app_origin_missing',
])

// ---------- P6a's argument shapes (PR0): ids, a revision and closed lists; never a fact's or a request's text ----------
/** The revision a team fact was decided at (memory.ts `MemoryForgetInputSchema`'s `ifRev` bounds). */
const MemoryRevSchema = z.number().int().min(1).max(999_999_999)
/** A team request: `tr_` + 128 random bits (W3's store makes it). */
export const TeamRequestIdSchema = z.string().regex(new RegExp(`^tr_${RANDOM}$`))
/** The Inhouse team window's request types (src/state/store.ts `RequestType`); "Request a skill" is `job`. */
export const TeamRequestKindSchema = z.enum(['tool', 'job', 'change', 'bug', 'feedback'])
/** Where a status change can move a request: it's created `open`, and only leaves it. */
export const TeamRequestStatusChangeSchema = z.enum(['done', 'declined', 'withdrawn'])
/** A brand skill: `bs_` + 128 random bits (the brand skills store makes it). Never its name, description or text. */
export const BrandSkillIdSchema = z.string().regex(new RegExp(`^bs_${RANDOM}$`))

// ---------- Stage 1 M2's argument shapes (N10, N18): ids, closed codes and counts; never an argument, a card's words,
// a question or an answer's text ----------
/** A write operation's key, written out (the client bundle imports nothing from the hub); the hub's `WRITE_OPERATIONS`. */
export const WriteOperationArgSchema = z.enum(['shopify.order.tag_add', 'slack.channel.post'])
// Fails the typecheck when the two lists differ, either way.
const sameOperations: [z.infer<typeof WriteOperationArgSchema>, WriteOperationKey] extends [WriteOperationKey, z.infer<typeof WriteOperationArgSchema>] ? true : never = true
void sameOperations
/** A scope as one key (server/permissions/resolve.ts `scopeKeyOf`): `name=value` pairs, URI-encoded, joined by `&`. */
export const ScopeKeyArgSchema = z.string().regex(/^[A-Za-z0-9%._~-]+=[A-Za-z0-9%._~-]{1,200}(?:&[A-Za-z0-9%._~-]+=[A-Za-z0-9%._~-]{1,200}){0,7}$/)
/** Why a live permission was revoked (server/permissions/policy.ts `REVOKE_REASONS`). */
export const RevokeReasonSchema = z.enum(['removed', 'member_removed', 'role_lowered', 'account_disconnected', 'account_reconnected', 'restore'])
/**
 * Why an approval lapsed, or a waiting card expired (N11, N12): the brand paused or a restore held the outbox; or, at
 * the claim, the operation is off, the policy changed, the account changed, the asker or the approver can't any
 * more, the channel isn't listed, the permission is gone, its use for the day is spent.
 */
export const LapseReasonSchema = z.enum([
  'paused', 'restore_hold', 'expired', 'over_ceiling', 'policy_changed', 'account_changed', 'asker_removed', 'approver_not_allowed',
  'channel_not_listed', 'permission_removed', 'count',
])
/** A failed send's code: the hub's closed error codes (app/hub/index/contract.ts `HubErrorCode`), never upstream text. */
export const ActionFailCodeSchema = ConnectOutcomeSchema.exclude(['ok'])
/** Why a send needs a person's check: no answer in time, the hub wasn't sure, the call threw, the answer didn't parse, the sending row went stale. */
export const NeedsCheckWhySchema = z.enum(['timeout', 'unknown', 'thrown', 'bad_result', 'stale'])
const ACTION_RECORDS = z.number().int().min(1).max(1_000_000)
const ACTION_ATTEMPT = z.number().int().min(1).max(1000)

const line = <A extends AuditAction, S extends z.ZodRawShape>(action: A, shape: S) => z.object({ action: z.literal(action), ...shape }).strict()
const member = { memberId: MemberIdSchema }

/** `setting.changed` as stored: the shape only. The registry's checks (below) run when a line is written. */
const settingChanged = line('setting.changed', {
  scope: SettingScopeSchema,
  key: SettingKeySchema,
  value: SettingValueSchema.nullable().optional(),
  redacted: RedactedValueSchema.optional(),
})

/** A backup's or a restore's id (ops/backup/backup.ts `timeId`): `<yyyymmdd>T<hhmmssSSS>Z-<8 hex>`. */
const RestoreIdSchema = z.string().regex(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/)

/** A privacy request (server/webhooks/shopify-privacy): `pr_` + the first 128 bits of a SHA-256 over Shopify's webhook id, base64url. */
export const PrivacyRequestIdSchema = z.string().regex(new RegExp(`^pr_${RANDOM}$`))
/** Shopify's three compliance topics (https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance). */
export const PrivacyTopicSchema = z.enum(['customers/data_request', 'customers/redact', 'shop/redact'])

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
  line('support.access', { grantId: GrantIdSchema, method: z.enum(['GET', 'PUT', 'POST']), route: z.union([RoutePatternSchema, WritePatternSchema, PostPatternSchema]) })
    .superRefine((a, ctx) => {
      // Runs even when a field above failed (zod 4), so it checks each value's type before using it.
      const pattern = a.method === 'GET' ? RoutePatternSchema : a.method === 'PUT' ? WritePatternSchema : a.method === 'POST' ? PostPatternSchema : null
      if (pattern && !pattern.safeParse(a.route).success) ctx.addIssue({ code: 'custom', path: ['route'], message: 'Not a route for this method' })
    }),
  line('agent.paused', {}),
  line('agent.resumed', {}),
  /** An Inhouse socket attach to a run, written before any of its frames are sent (p3-design 4.10). */
  line('support.attach', { grantId: GrantIdSchema, runId: RunIdSchema }),
  /** A team fact forgotten, or that undone (it then waits for an admin's OK again). Ids only, never the fact's text. */
  line('memory.forgotten', { memoryId: MemoryIdArgSchema }),
  line('memory.restored', { memoryId: MemoryIdArgSchema }),
  /**
   * Route 51: one due task revived (or found not quarantined, or not there). `by` names the service that asked: the
   * release token has no member row, so the line's actor is `m_system`.
   */
  line('ops_task_revive', { kind: TaskKindSchema, id: TaskIdSchema, result: ReviveResultSchema, by: z.literal('release') }),
  // P4 (wave-4 PR0). Ids, counts and closed lists only: no routine name, instruction, file name or item title.
  /** `need`: the stage the routine needs (0 Watch, 1 Act, 2 Run; p4-w2.md section 2). */
  line('routine.created', { routineId: RoutineIdSchema, need: z.number().int().min(0).max(2) }),
  /** `changed`: which parts an edit changed, each once. */
  line('routine.updated', {
    routineId: RoutineIdSchema,
    changed: z.array(RoutineChangeSchema).min(1).max(3).refine(c => new Set(c).size === c.length, 'Each part once'),
  }),
  line('routine.enabled', { routineId: RoutineIdSchema, on: z.boolean() }),
  line('routine.deleted', { routineId: RoutineIdSchema }),
  line('routine.restored', { routineId: RoutineIdSchema }),
  /** The slot key names the same routine as `routineId` (a manual key `now|<id>|...`, or a scheduled `<id>|...`). */
  line('routine.run_now', { routineId: RoutineIdSchema, slotKey: SlotKeySchema }).superRefine((a, ctx) => {
    if (typeof a.slotKey !== 'string' || typeof a.routineId !== 'string') return
    const parts = a.slotKey.split('|')
    if ((parts[0] === 'now' ? parts[1] : parts[0]) !== a.routineId) ctx.addIssue({ code: 'custom', path: ['slotKey'], message: "Not this routine's slot" })
  }),
  line('library.uploaded', { fileId: FileIdSchema, contentType: LibraryTypeSchema, bytes: z.number().int().min(1).max(LIBRARY_MAX_BYTES) }),
  line('library.deleted', { fileIds: FileIdsSchema }),
  line('library.restored', { fileIds: FileIdsSchema }),
  /** `reason: null`: the item was put back (a snooze or a dismissal undone). */
  line('today.set_aside', { itemId: TodayItemIdSchema, reason: z.enum(['snoozed', 'dismissed', 'declined']).nullable() }),
  // P8a R. The restore's and the backup's ids only (`timeId`: a UTC stamp and 8 hex characters), never a row of either.
  /** `approvedBy`: the brand's Admin who approved it (an Inhouse operator only when none is left); the actor ran it. */
  line('restore.confirmed', { restoreId: RestoreIdSchema, backupId: RestoreIdSchema, approvedBy: MemberIdSchema }),
  /** The member id the placeholder row keeps (its actor's audit lines need it), and the restore that wrote it. */
  line('restore.member_placeholder', { memberId: MemberIdSchema, restoreId: RestoreIdSchema }),
  // P8a F2. The actor is `m_system` on both: Shopify and the release token have no member row.
  /** `parsed: false`: Shopify signed it but the body wasn't the topic's shape; recorded with no ids, for the team to read. */
  line('privacy.requested', { requestId: PrivacyRequestIdSchema, topic: PrivacyTopicSchema, parsed: z.boolean() }),
  line('privacy.closed', { requestId: PrivacyRequestIdSchema, topic: PrivacyTopicSchema, by: z.literal('release') }),
  // P5 (p5-w1): connect start (route A) and its end (route B), the account id and the outcome code only.
  line('tools.connect_start', { accountId: ConnectorAccountIdSchema }),
  line('tools.connect', { accountId: ConnectorAccountIdSchema, outcome: ConnectOutcomeSchema }),
  // P5 (p5-w3): a pause or resume that changed something (route D), and a disconnect (route E) with whether the access was revoked.
  line('tools.pause', { accountId: ConnectorAccountIdSchema, paused: z.boolean() }),
  line('tools.disconnect', { accountId: ConnectorAccountIdSchema, revoked: z.boolean() }),
  // P5 (p5-w4): one line per recipient per call (`repeat`: the same notice again, answered with the first outcome), and
  // the channel list's change (route H). `target` is a channel id, a member id, `admins`, or `unlisted` for a channel name
  // the agent gave that isn't listed (never the name itself: it's the agent's text).
  line('notify.send', {
    source: NotifySourceSchema,
    runId: RunIdSchema.optional(),
    systemKey: z.string().regex(/^[A-Za-z0-9:_.-]{1,128}$/).optional(),
    noticeKind: SystemNoticeKindSchema.optional(),
    kind: z.enum(['slack', 'bell']),
    target: z.union([SlackChannelIdSchema, MemberIdSchema, z.literal('admins'), z.literal('unlisted')]),
    outcome: NotifyOutcomeSchema,
    detail: NotifyDetailSchema.optional(),
    changed: z.array(z.enum(['links', 'mentions', 'link_dropped'])).min(1).max(3).optional(),
    repeat: z.literal(true).optional(),
    textLength: z.number().int().min(0).max(2000),
    noticeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).superRefine((a, ctx) => {
    // `unlisted` only ever names a refused Slack recipient: nothing is sent to it, and it is no bell.
    if (a.target === 'unlisted' && (a.kind !== 'slack' || a.outcome !== 'refused')) ctx.addIssue({ code: 'custom', path: ['target'], message: 'unlisted is a refused Slack recipient only' })
  }),
  line('notify.channels', {
    added: z.array(SlackChannelIdSchema).max(100),
    removed: z.array(SlackChannelIdSchema).max(100),
    alerts: SlackChannelIdSchema.nullable().optional(),
  }),
  // P6a (PR0). `rev`: the revision the admin decided (the one the fact had while it waited).
  line('memory.approved', { memoryId: MemoryIdArgSchema, rev: MemoryRevSchema }),
  line('memory.rejected', { memoryId: MemoryIdArgSchema, rev: MemoryRevSchema }),
  line('team_request.created', { requestId: TeamRequestIdSchema, kind: TeamRequestKindSchema }),
  line('team_request.status', { requestId: TeamRequestIdSchema, status: TeamRequestStatusChangeSchema }),
  line('brand_skill.created', { skillId: BrandSkillIdSchema }),
  line('brand_skill.changed', { skillId: BrandSkillIdSchema }),
  line('brand_skill.deleted', { skillId: BrandSkillIdSchema }),
  // P8a D (route 95). Counts only: how many stores and how many rows and files the export planned. Never a store's
  // name, a row, a file name or anything a row holds.
  line('data.exported', { scope: z.literal('brand'), stores: z.number().int().min(0).max(1000), items: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
  // Stage 1 M2 (N10, N18). Ids, the operation, the scope key, closed codes and counts only.
  /** "Always allow" made a permission. `actionId`: the answer that made it (absent for one made another way). */
  line('permission.granted', {
    permissionId: PermissionIdSchema, operation: WriteOperationArgSchema, accountId: ConnectorAccountIdSchema, scopeKey: ScopeKeyArgSchema,
    holder: z.enum(['member', 'brand']), perDay: z.number().int().min(1).max(100_000), actionId: ActionIdSchema.optional(),
  }),
  line('permission.revoked', { permissionId: PermissionIdSchema, operation: WriteOperationArgSchema, reason: RevokeReasonSchema }),
  /** `permissionId`: a `run` under that permission, its use reserved with the action. */
  line('action.requested', {
    actionId: ActionIdSchema, operation: WriteOperationArgSchema, verdict: z.enum(['run', 'ask', 'exact']), guardrail: GuardrailSchema.optional(),
    origin: z.enum(['chat', 'job', 'routine']), records: ACTION_RECORDS, units: ACTION_RECORDS, permissionId: PermissionIdSchema.optional(),
  }),
  /** `permissionId`: the permission an "Always allow" made or found, whose use this action reserved. */
  line('action.answered', { actionId: ActionIdSchema, choice: ActionChoiceSchema, permissionId: PermissionIdSchema.optional() }),
  /** `released`: the action's reserved use was given back. */
  line('action.undone', { actionId: ActionIdSchema, released: z.boolean() }),
  line('action.withdrawn', { actionId: ActionIdSchema, by: z.enum(['member', 'agent']) }),
  line('action.lapsed', { actionId: ActionIdSchema, reason: LapseReasonSchema, released: z.boolean() }),
  line('action.sent', { actionId: ActionIdSchema, attempt: ACTION_ATTEMPT }),
  line('action.failed', { actionId: ActionIdSchema, attempt: ACTION_ATTEMPT.optional(), code: ActionFailCodeSchema, released: z.boolean() }),
  line('action.needs_check', { actionId: ActionIdSchema, attempt: ACTION_ATTEMPT, why: NeedsCheckWhySchema }),
  /** A person said whether a "Needs a check" action went out. `released`: "it didn't" gave the use back. */
  line('action.resolved', { actionId: ActionIdSchema, outcome: ActionResolutionSchema, released: z.boolean() }),
  /** `askedOf`: the chat's owner, the routine's creator, or every admin (a routine whose creator is gone). No member id. */
  line('question.asked', { questionId: QuestionIdSchema, askedOf: z.enum(['owner', 'creator', 'admins']), options: z.number().int().min(2).max(4) }),
  line('question.answered', { questionId: QuestionIdSchema }),
  line('question.expired', { questionId: QuestionIdSchema }),
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
