// The Worker <-> runner wire protocol (P3). One schema set, parsed by the Worker with the app's zod and by the root
// runner with the runner's own zod (the zod-major check keeps them one dialect).
//
// Unknown fields: every object here is strict, so a field the other side doesn't know fails the parse loudly. Any change
// to a schema bumps PROTOCOL_VERSION; a side that still accepts the previous version keeps that version's schemas.
// The one open shape is the SDK message inside an `sdk` event, passed through as data.
import { z } from 'zod'
import { badFileName } from '../files/names.ts'
import { BrandSkillFiles } from './brand-skills.ts'

export const PROTOCOL_VERSION = 3
/**
 * The versions this side speaks. The rule: the current one and the one before, so a Worker one version ahead still runs
 * chats. v1 was never deployed, so the rule started at v2. v3 (P6a, brand skills) adds `RunStart.brandSkills`, optional:
 * a v2 start is a v3 start without it, so one schema reads both, and the Worker leaves it out when it talks v2.
 */
export const ACCEPTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION, 2]
/** The first version whose `RunStart` may carry `brandSkills`. */
export const BRAND_SKILLS_VERSION = 3
/** Every request to the runner (except the discovery routes `/protocol` and `/health`) carries this header. */
export const PROTOCOL_HEADER = 'x-inhouse-protocol'

/** `GET /protocol`. */
export const ProtocolInfo = z.strictObject({
  version: z.int().nonnegative(),
  accepted: z.array(z.int().nonnegative()).min(1),
})
export type ProtocolInfo = z.infer<typeof ProtocolInfo>

/**
 * True when a request's protocol header names a version this side accepts. Canonical decimals only (`1`, not `01` or
 * `+1`); a missing or unreadable header is false.
 */
export function acceptsVersion(header: string | null | undefined, accepted: readonly number[] = ACCEPTED_VERSIONS): boolean {
  if (header == null || !/^(0|[1-9]\d{0,5})$/.test(header)) return false
  return accepted.includes(Number(header))
}

/**
 * The version to speak with a peer: the highest version both sides accept, or null when there's none.
 * The Worker calls this with the runner's `GET /protocol` answer.
 */
export function negotiateVersion(peer: ProtocolInfo, ours: readonly number[] = ACCEPTED_VERSIONS): number | null {
  const shared = peer.accepted.filter((v) => ours.includes(v))
  return shared.length === 0 ? null : Math.max(...shared)
}

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
/** The SDK takes session ids as UUIDs. */
const SessionId = z.uuid()
const Hostname = z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/)

/** Caps on the files a run saves from `outputs/` and restores on resume. */
export const FileCaps = z.strictObject({
  maxFileBytes: z.int().positive(),
  maxFilesPerTurn: z.int().positive(),
  maxRestoreBytes: z.int().nonnegative(),
  /** Allowed content types, as detected from magic bytes (e.g. `application/pdf`). */
  allowedTypes: z.array(z.string().regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)).max(64),
})
export type FileCaps = z.infer<typeof FileCaps>

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

/** The prompt cap, in characters. */
export const PROMPT_MAX_CHARS = 200_000
/** The system prompt cap, in UTF-8 bytes. */
export const SYSTEM_PROMPT_MAX_BYTES = 64 * 1024
/** The cap on a structured-output JSON Schema (`RunStart.outputFormat.schema`), as JSON bytes. */
export const OUTPUT_SCHEMA_MAX_BYTES = 16 * 1024
/** The cap on a run's structured output (`finished.structuredOutput`), as JSON bytes; over it the run fails `structured_output`. */
export const STRUCTURED_OUTPUT_MAX_BYTES = 64 * 1024
/**
 * The deepest nesting (arrays and objects) a structured-output schema or value may have. The local channel refuses a
 * line nested past 256 levels (the runner's LOCAL_MAX_DEPTH), so a deeper value would fail the run `protocol` and lose
 * finished work: capped well below it.
 */
export const STRUCTURED_MAX_DEPTH = 64

/**
 * How deep a JSON value nests: 0 for a scalar, 1 for `{}` or `[]`, one more per level. Iterative, so it never throws
 * (however deep the value), and stops counting past `limit` (returns `limit + 1`).
 */
export function jsonDepth(value: unknown, limit = STRUCTURED_MAX_DEPTH): number {
  let max = 0
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length > 0) {
    const [v, d] = stack.pop()!
    if (v === null || typeof v !== 'object') continue
    const depth = d + 1
    if (depth > limit) return limit + 1
    if (depth > max) max = depth
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, depth])
  }
  return max
}

/** Within the caps for structured output: at most `maxBytes` as JSON and `STRUCTURED_MAX_DEPTH` deep. Never throws. */
export function structuredWithinCaps(value: unknown, maxBytes: number): boolean {
  try {
    return jsonDepth(value) <= STRUCTURED_MAX_DEPTH && jsonBytes(value) <= maxBytes
  } catch {
    return false
  }
}

/**
 * Structured output (the Agent SDK's `outputFormat`): the run's answer is a JSON value matching `schema` (JSON Schema
 * draft-07, as the SDK validates it), returned by the SDK's `StructuredOutput` tool.
 */
export const OutputFormat = z.strictObject({
  type: z.literal('json_schema'),
  schema: z
    .record(z.string(), z.unknown())
    .refine((v) => structuredWithinCaps(v, OUTPUT_SCHEMA_MAX_BYTES), { message: `schema over ${OUTPUT_SCHEMA_MAX_BYTES} bytes or ${STRUCTURED_MAX_DEPTH} levels deep` }),
})
export type OutputFormat = z.infer<typeof OutputFormat>
/** The most attachments one run start names. */
export const ATTACHMENTS_MAX = 10
/**
 * The runner's cap on a `POST /runs` body, in bytes. JSON can escape one prompt character as six bytes (`\u0000`), so
 * the cap fits a prompt at its cap written that way, plus every other field at its own cap (checked in wire.test.ts).
 */
export const RUN_START_MAX_BYTES = 2 * 1024 * 1024

const utf8 = new TextEncoder()

const Model = z.string().regex(/^[A-Za-z0-9._:@/-]{1,128}$/)
const FilePath = z.string().max(1024)

/**
 * What a resume expects the store to hold (the Worker's last checkpoint for the chat): at least `mainEntries` entries in
 * the main transcript (subagent transcripts don't count) and, when `lastUuid` isn't null, uuid `lastUuid` on entry
 * `lastUuidIndex` (the last entry that has a uuid; uuids are optional, so with none only the length is checked).
 */
export const ResumeExpect = z
  .strictObject({ mainEntries: z.int().min(1), lastUuid: z.string().min(1).max(256).nullable(), lastUuidIndex: z.int().nonnegative().nullable() })
  .superRefine(checkLastUuid)
export type ResumeExpect = z.infer<typeof ResumeExpect>

/** `lastUuid` and `lastUuidIndex` are both null or both set, and the index is inside `mainEntries`. */
function checkLastUuid(v: { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null }, ctx: z.RefinementCtx) {
  if ((v.lastUuid === null) !== (v.lastUuidIndex === null)) ctx.addIssue({ code: 'custom', path: ['lastUuidIndex'], message: 'lastUuid and lastUuidIndex are both null or both set' })
  if (v.lastUuidIndex !== null && v.lastUuidIndex >= v.mainEntries) ctx.addIssue({ code: 'custom', path: ['lastUuidIndex'], message: 'lastUuidIndex is past mainEntries' })
}

/** The fields of a `POST /runs` body; `RunStart` adds the cross-field rules. */
export const RunStartFields = z.strictObject({
  runId: Id,
  chatId: Id,
  sessionId: SessionId,
  /** false on a session's first run (`sessionId`), true after (`resume`). */
  resume: z.boolean(),
  /** `""` resumes after a deferred tool call's answer, so it's allowed only with `resume: true`. */
  prompt: z.string().max(PROMPT_MAX_CHARS),
  model: Model,
  /** The engine's background (Haiku-class) model; subagents use `model`. */
  sideModel: Model,
  /** Set by the Worker (the brand's agent instructions and the house prompt). */
  systemPrompt: z.string().refine((p) => utf8.encode(p).length <= SYSTEM_PROMPT_MAX_BYTES, { message: `system prompt over ${SYSTEM_PROMPT_MAX_BYTES} bytes` }),
  /**
   * This turn's attachments, paths under `inputs/`: restored first; the Worker names them in the prompt. Each is a name
   * the files route can carry (`badFileName`: no empty, `.` or `..` segment, `#`, `\`, control character, segment over
   * 255 UTF-8 bytes or unpaired surrogate, so not `inputs/` alone), and none twice. The 1,024-character cap is the whole
   * path's: a path that long has several segments.
   */
  attachments: z
    .array(FilePath.startsWith('inputs/').refine((p) => !badFileName(p), { message: 'a name the files route cannot carry' }))
    .max(ATTACHMENTS_MAX)
    .refine((a) => new Set(a).size === a.length, { message: 'an attachment named twice' }),
  /** Required (non-null) when `resume`, null on a session's first run. */
  expect: ResumeExpect.nullable(),
  effort: Effort,
  maxTurns: z.int().min(1).max(500),
  maxBudgetUsd: z.number().positive().max(1000),
  runToken: z.string().regex(/^[\x21-\x7e]{16,512}$/),
  /**
   * WebFetch's reach (Wasim, decision 20: on from the start). A list: only those hosts; `[]`: none. `null`: any public
   * host (the runner still refuses IP literals, local names and its own host); since P8a S the Worker never sends it
   * (an empty `t:webfetch` is `[]`), and its egress refuses every host not on the brand's list whatever the runner got.
   */
  webFetchDomains: z.array(Hostname).max(200).nullable(),
  /**
   * Optional (v2, additive; P8a S): the engine's WebSearch tool. The runner offers it only when this is `true`; absent
   * (a Worker from before P8a) or `false` is off. The Worker's model route also refuses a web search request on a brand
   * whose `t:websearch` isn't on, whatever the runner sent.
   */
  webSearch: z.boolean().optional(),
  fileCaps: FileCaps,
  /**
   * Optional (v2, additive): the run answers with structured output. The runner gives the SDK the format and lets its
   * `StructuredOutput` tool through only then; the answer comes back as `finished.structuredOutput`.
   */
  outputFormat: OutputFormat.optional(),
  /**
   * Optional (v3): the brand's own skills (shared/protocol/brand-skills.ts). The root runner writes them, root-owned and
   * read-only, as a plugin beside ours before the session starts; the guards add each one to the session's skills.
   */
  brandSkills: BrandSkillFiles.optional(),
})

/** Cross-field rules shared by `RunStart` and the runner's run config (the same fields less the token). */
export function checkRunStart(v: { prompt: string; resume: boolean; expect: unknown }, ctx: z.RefinementCtx) {
  if (v.prompt === '' && !v.resume) ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'an empty prompt is only for a resume' })
  if (v.resume && v.expect === null) ctx.addIssue({ code: 'custom', path: ['expect'], message: 'a resume carries expect' })
  if (!v.resume && v.expect !== null) ctx.addIssue({ code: 'custom', path: ['expect'], message: "a session's first run has no expect" })
}

/** `POST /runs` body. The run token is accepted here and nowhere else. */
export const RunStart = RunStartFields.superRefine(checkRunStart)
export type RunStart = z.infer<typeof RunStart>

/**
 * `POST /runs` answers `202 RunAdmission` once the runner admitted the run; its events then go to the egress
 * (`PushBatch`), never on this answer.
 */
export const RunAdmission = z.strictObject({ accepted: z.literal(true) })
export type RunAdmission = z.infer<typeof RunAdmission>

/**
 * The refusals of `POST /runs` the Worker routes on, each with its status (`RUN_REFUSAL_STATUS`): the uid pool is full
 * or the chat's folder is parked (503: try another runner, or never), the chat or this run id is live here (409: a
 * definite non-admission). Other refusals (a bad body, a stopping runner, a wrong version) are an `ErrorBody`.
 */
export const RunRefusalCode = z.enum(['session_pool_exhausted', 'session_folder_parked', 'chat_live', 'run_live'])
export type RunRefusalCode = z.infer<typeof RunRefusalCode>
export const RunRefusal = z.strictObject({ error: RunRefusalCode })
export type RunRefusal = z.infer<typeof RunRefusal>
export const RUN_REFUSAL_STATUS: Readonly<Record<RunRefusalCode, 409 | 503>> = {
  session_pool_exhausted: 503,
  session_folder_parked: 503,
  chat_live: 409,
  run_live: 409,
}

/** The largest SDK message passed through whole in an `sdk` event; a bigger one arrives as a stub with `truncated`. */
export const SDK_MESSAGE_MAX_BYTES = 256 * 1024

/**
 * `files`: the chat's files couldn't be brought into the work folder, so the run didn't start its query.
 * `structured_output`: the run was asked for structured output and has none it can give (the SDK ran out of retries,
 * the run ended without one, or it is over `STRUCTURED_OUTPUT_MAX_BYTES` or `STRUCTURED_MAX_DEPTH`). A result the SDK
 * already gave wins over a stop that races it: such a run ends `structured_output` (or `finished`), not `stopped`, so
 * the Worker must not assume a stop always yields `stopped`.
 */
export const FailureReason = z.enum(['session_crashed', 'protocol', 'store', 'files', 'interrupted', 'stopped', 'timeout', 'sdk_error', 'structured_output'])
export type FailureReason = z.infer<typeof FailureReason>

/**
 * `bad_name`: a name the files route can't carry (a `#` or `\`, a `.` or `..` segment, a control character, a segment
 * over 255 UTF-8 bytes, an unpaired surrogate).
 */
export const FileRefusalReason = z.enum(['too_large', 'too_many', 'type_not_allowed', 'save_failed', 'bad_name'])

/** Caps on the open shapes a session sends, as JSON bytes. An event over one fails the parse (`protocol`). */
export const DEFERRED_INPUT_MAX_BYTES = 64 * 1024
export const USAGE_MAX_BYTES = 32 * 1024

/** The size of a value as JSON, in UTF-8 bytes; Infinity for a value JSON can't encode. */
export function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? 0 : utf8.encode(text).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The cap on an audit entry's `input`, as JSON bytes. */
export const AUDIT_INPUT_MAX_BYTES = 16 * 1024

/**
 * One entry of the blocking audit log (R2's hook builds them). The session sends it to the root, which posts it to the
 * egress's `/audit/` (`AuditPost`) and acks the hook only on its 204; the hook's call goes ahead only on that ack. The
 * entry also goes out as an `audit` run event, for the trace.
 */
export const AuditEntry = z.strictObject({
  /** The hook event, e.g. `PreToolUse`. */
  hook: z.string().regex(/^[A-Za-z]{1,64}$/),
  toolName: z.string().max(256),
  toolUseId: z.string().max(256).optional(),
  /** What the hook decided, e.g. `allow`, `deny`, `defer`. */
  decision: z.string().max(64),
  input: z.unknown().refine((i) => jsonBytes(i) <= AUDIT_INPUT_MAX_BYTES, { message: `input over ${AUDIT_INPUT_MAX_BYTES} bytes` }),
})
export type AuditEntry = z.infer<typeof AuditEntry>

const Usage = z.record(z.string(), z.unknown()).refine((u) => jsonBytes(u) <= USAGE_MAX_BYTES, { message: `usage over ${USAGE_MAX_BYTES} bytes` })

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * The store's state after a run: what the next resume's `expect` is built from. `mainEntries: 0` (with `lastUuid` and
 * `lastUuidIndex` both null) means the store holds no main transcript for the session: the Worker keeps the session
 * `none` (a fresh sessionId on the next turn), never `resumable`. A resume's `expect` starts at 1 for that reason.
 */
const CheckpointState = z.strictObject({ mainEntries: z.int().nonnegative(), lastUuid: z.string().min(1).max(256).nullable(), lastUuidIndex: z.int().nonnegative().nullable() })

/**
 * An `sdk` event before the root runner caps its message: what a session sends the root on the local channel. The root
 * caps it (`capSdkMessage`) before it goes on the wire as a `RunEventBody`.
 */
export const SdkEventUncapped = z.strictObject({ type: z.literal('sdk'), message: z.record(z.string(), z.unknown()), truncated: z.boolean() })

/** A run event without its envelope. The root runner stamps `runId` and `seq`. */
export const RunEventBody = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), sessionId: SessionId, resume: z.boolean() }),
  SdkEventUncapped.extend({
    /**
     * The SDK message as data, at most `SDK_MESSAGE_MAX_BYTES` as JSON (the runner's cap, measured the same way). When
     * `truncated`, only `type`, `subtype` and `bytes` are kept.
     */
    message: SdkEventUncapped.shape.message.refine((m) => jsonBytes(m) <= SDK_MESSAGE_MAX_BYTES, { message: `message over ${SDK_MESSAGE_MAX_BYTES} bytes` }),
  }),
  /** `sha256`: the saved bytes' SHA-256, lower-case hex (the PUT's `x-inhouse-sha256`); the Worker confirms by it. */
  z.strictObject({ type: z.literal('file_saved'), path: FilePath, bytes: z.int().nonnegative(), contentType: z.string().max(128), sha256: Sha256 }),
  z.strictObject({ type: z.literal('file_refused'), path: FilePath, reason: FileRefusalReason, bytes: z.int().nonnegative().optional() }),
  /** The refusals past the first 50 of a run, counted rather than sent one by one. */
  z.strictObject({ type: z.literal('file_refused_more'), count: z.int().positive() }),
  /**
   * The chat's files, brought into the work folder at the run's start (`inputs/` and `outputs/`), up to
   * `maxRestoreBytes`; `leftOut` names the ones over the cap (the agent is told too, when the run has a prompt).
   */
  z.strictObject({ type: z.literal('files_restored'), restored: z.int().nonnegative(), bytes: z.int().nonnegative(), leftOut: z.array(FilePath).max(1000) }),
  /** A blocking audit entry. Written before the session's hook is acked, so it's on the stream before the call runs. */
  z.strictObject({ type: z.literal('audit'), entry: AuditEntry }),
  /**
   * The store couldn't be brought to hold every entry of this run (the repair failed). No `checkpoint` follows: the
   * Worker must not mark the chat waiting on this run's transcript.
   */
  z.strictObject({ type: z.literal('mirror_error'), message: z.string().max(2000) }),
  /**
   * The run's lone call was deferred (it waits for an answer). Sent before the run's files are saved and before its
   * `checkpoint`, so it says nothing about the transcript: the Worker marks the chat waiting on the call only once the
   * run's `checkpoint` has come too, never on `deferred` alone (W1 and W3 rely on this). With `mirror_error` instead of
   * `checkpoint`, the chat is not marked waiting.
   */
  z.strictObject({
    type: z.literal('deferred'),
    toolUseId: z.string().max(256),
    toolName: z.string().max(256),
    input: z.unknown().refine((i) => jsonBytes(i) <= DEFERRED_INPUT_MAX_BYTES, { message: `input over ${DEFERRED_INPUT_MAX_BYTES} bytes` }),
  }),
  /**
   * The store confirmed every batch of this run. `mainEntries` is the store's **total** main-transcript length after
   * this run (subagent transcripts don't count), `lastUuid` the uuid of the last of them that has one and
   * `lastUuidIndex` its index (both null when none has one): the next resume's `expect`. `runEntries` is this run's own
   * count, for the log. The only event the Worker marks a chat waiting on (with an earlier `deferred`): never
   * `deferred` by itself. `mainEntries: 0` (a first run that wrote no main transcript) leaves the session `none`, never
   * `resumable`: the next turn starts a fresh session.
   */
  z.strictObject({ type: z.literal('checkpoint'), ...CheckpointState.shape, runEntries: z.int().nonnegative() }).superRefine(checkLastUuid),
  /** Sent when nothing else happened for 30 s, so the Worker sees the run alive through a silent tool call. */
  z.strictObject({ type: z.literal('heartbeat') }),
  /**
   * The last event of every run, on every exit path: the session process exited, its store flush finished and the
   * runner freed the chat. `checkpoint` is the run's checkpoint result (as in `checkpoint`), or null when there's none
   * (no checkpoint was taken, or it failed), with `mainEntries: 0` meaning as there that the session stays `none`, never
   * `resumable`; `queryRan` is false when the run ended before its query started (a stop
   * during the file restore or before the query), so there's no transcript to keep.
   */
  z.strictObject({ type: z.literal('released'), checkpoint: CheckpointState.superRefine(checkLastUuid).nullable(), queryRan: z.boolean() }),
  z.strictObject({
    type: z.literal('finished'),
    subtype: z.string().max(64),
    isError: z.boolean(),
    numTurns: z.int().nonnegative(),
    costUsd: z.number().nonnegative(),
    usage: Usage,
    /** The run's structured output (only when `RunStart.outputFormat` was set), validated by the SDK against its schema. */
    structuredOutput: z
      .unknown()
      .refine((v) => structuredWithinCaps(v, STRUCTURED_OUTPUT_MAX_BYTES), { message: `structured output over ${STRUCTURED_OUTPUT_MAX_BYTES} bytes or ${STRUCTURED_MAX_DEPTH} levels deep` })
      .optional(),
  }),
  z.strictObject({ type: z.literal('failed'), reason: FailureReason, message: z.string().max(2000) }),
])
export type RunEventBody = z.infer<typeof RunEventBody>

const RunEventEnvelope = z.strictObject({ runId: Id, seq: z.int().nonnegative() })

/** A run event: the body plus `runId` and `seq` (from 0 per run, no gaps). */
export type RunEvent = z.infer<typeof RunEventEnvelope> & RunEventBody

/** Exactly one per run. `released` follows it (after the session's exit and store flush). */
export const TERMINAL_EVENTS: ReadonlySet<RunEventBody['type']> = new Set(['finished', 'failed'])

/** Parses a run event (envelope and body, both strict); throws on anything else. */
export function parseRunEvent(raw: unknown): RunEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('run event is not an object')
  const { runId, seq, ...body } = raw as Record<string, unknown>
  return { ...RunEventEnvelope.parse({ runId, seq }), ...RunEventBody.parse(body) }
}

/** Parses one NDJSON line into a run event; throws on anything else. */
export function parseRunEventLine(line: string): RunEvent {
  return parseRunEvent(JSON.parse(line))
}

export function encodeRunEvent(event: RunEvent): string {
  return `${JSON.stringify(event)}\n`
}

/** The most events in one push. */
export const PUSH_BATCH_MAX_EVENTS = 200
/**
 * The root's buffer of unacked events per run, as the sum of each event's JSON bytes (with its `runId` and `seq`); a
 * full buffer pauses reading the session. A batch is taken from the buffer, so its events never sum past this.
 */
export const PUSH_BUFFER_MAX_BYTES = 2 * 1024 * 1024
/**
 * The cap on a `POST /events/` body (W3's byte check before the parse): the events at `PUSH_BUFFER_MAX_BYTES` plus the
 * batch's own JSON around them, at most 288 bytes: `{"turnId":"` (11), a 64-byte id, `","events":[` (12), `]}` (2) and
 * a comma between each of `PUSH_BATCH_MAX_EVENTS` events (199). Checked in wire.test.ts.
 */
export const PUSH_BATCH_MAX_BYTES = PUSH_BUFFER_MAX_BYTES + 11 + 64 + 12 + 2 + (PUSH_BATCH_MAX_EVENTS - 1)

/**
 * `POST /events/` body (the root runner, with the run's token): a run's next events, `seq` consecutive, every one of
 * the run `turnId`. One batch in flight per run: the next goes only after this one's `PushAck`; a failed one is sent
 * again unchanged.
 */
export const PushBatch = z
  .strictObject({ turnId: Id, events: z.array(z.unknown()).min(1).max(PUSH_BATCH_MAX_EVENTS) })
  .transform((b, ctx) => {
    const events: RunEvent[] = []
    for (const [i, raw] of b.events.entries()) {
      try {
        events.push(parseRunEvent(raw))
      } catch (e) {
        ctx.addIssue({ code: 'custom', path: ['events', i], message: e instanceof Error ? e.message : 'not a run event' })
        return z.NEVER
      }
    }
    for (const [i, e] of events.entries()) {
      if (e.runId !== b.turnId) ctx.addIssue({ code: 'custom', path: ['events', i, 'runId'], message: 'an event of another run' })
      if (i > 0 && e.seq !== events[i - 1]!.seq + 1) ctx.addIssue({ code: 'custom', path: ['events', i, 'seq'], message: 'seq not consecutive' })
    }
    return { turnId: b.turnId, events }
  })
export type PushBatch = z.output<typeof PushBatch>

/**
 * `POST /events/` 200 answer. `ackSeq`: the highest seq the Worker holds for the run (a batch at or below it was a
 * resend). `stop`: the Worker fenced the run; the runner stops it and keeps pushing its `checkpoint`, `mirror_error`,
 * terminal event and `released`. A 410 (the run has ended at the Worker) drops the batch.
 */
export const PushAck = z.strictObject({ ackSeq: z.int().nonnegative(), stop: z.boolean() })
export type PushAck = z.infer<typeof PushAck>

/**
 * `POST /audit/` body (the root runner, with the run's token): one blocking audit entry, `n` counting from 0 per run.
 * The session's hook is acked only on the Worker's 204; anything else (or 10 s without an answer) denies the call.
 */
export const AuditPost = z.strictObject({ turnId: Id, n: z.int().nonnegative(), entry: AuditEntry })
export type AuditPost = z.infer<typeof AuditPost>

/**
 * `GET /runs/:runId` answer. `lastSeq`: the last event seq the root stamped; `ackedSeq`: the last the egress acked
 * (null before the first). `unknown`: the root doesn't know the run (never admitted, or released and forgotten), with
 * both null.
 */
export const RunStatus = z
  .strictObject({
    state: z.enum(['admitted', 'running', 'ending', 'released', 'unknown']),
    lastSeq: z.int().nonnegative().nullable(),
    ackedSeq: z.int().nonnegative().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.state === 'unknown' && (v.lastSeq !== null || v.ackedSeq !== null)) ctx.addIssue({ code: 'custom', path: ['state'], message: 'an unknown run has no seqs' })
    if (v.ackedSeq !== null && (v.lastSeq === null || v.ackedSeq > v.lastSeq)) ctx.addIssue({ code: 'custom', path: ['ackedSeq'], message: 'acked past the last seq' })
  })
export type RunStatus = z.infer<typeof RunStatus>

// ---- The loopback proxy's store and files routes (the session calls them; the Worker's egress serves them, scoped to
// the run's chat by its token). Paths are relative to the proxy's `/store/` and `/files/`.

/** The SDK's session key. `subpath` is set for subagent transcripts and is opaque to the store. */
export const StoreKey = z.strictObject({
  projectKey: z.string().min(1).max(512),
  sessionId: SessionId,
  subpath: z.string().min(1).max(512).optional(),
})
export type StoreKey = z.infer<typeof StoreKey>
/** A transcript line, passed through as data. */
export const StoreEntry = z.looseObject({ type: z.string(), uuid: z.string().optional() })

/**
 * `POST /store/append`. One stored part per batch: `part` sorts in append order, and a batch sent again (the SDK's
 * retry, or the runner's repair) carries the same `part`, so the store overwrites it rather than adding a copy.
 */
export const StoreAppend = z.strictObject({ key: StoreKey, entries: z.array(StoreEntry), part: z.string().regex(/^[0-9]{15}-[0-9]{6}$/) })
/** `POST /store/load` -> `StoreLoadResult` (`entries: null` for a key never written). */
export const StoreLoad = z.strictObject({ key: StoreKey })
export const StoreLoadResult = z.strictObject({ entries: z.array(StoreEntry).nullable() })
/** `POST /store/list-subkeys` -> `StoreSubkeys`. */
export const StoreListSubkeys = z.strictObject({ key: StoreKey.omit({ subpath: true }) })
export const StoreSubkeys = z.strictObject({ subkeys: z.array(z.string().min(1).max(512)) })

/**
 * `GET /files/` -> the chat's files (attachments under `inputs/`, saved outputs under `outputs/`), restore order first.
 * `GET /files/<path>` gives one file's bytes; `PUT /files/<path>` saves one (`content-type` as detected from its magic
 * bytes). `<path>` is the file's path with every segment `encodeURIComponent`-encoded.
 */
export const FileListing = z.strictObject({ files: z.array(z.strictObject({ path: FilePath, bytes: z.int().nonnegative() })).max(10_000) })
export type FileListing = z.infer<typeof FileListing>

/** `GET /health`. Memory comes from `/proc/meminfo` and `process.memoryUsage()`, not the cgroup files. */
export const Health = z.strictObject({
  ok: z.boolean(),
  protocol: z.int().nonnegative(),
  live: z.int().nonnegative(),
  /** Session users a failed cleanup took out of the runner's pool. Optional: a runner from before the guards omits it. */
  quarantinedUsers: z.int().nonnegative().optional(),
  memory: z.strictObject({
    totalBytes: z.int().nonnegative().nullable(),
    availableBytes: z.int().nonnegative().nullable(),
    rssBytes: z.int().nonnegative(),
    heapUsedBytes: z.int().nonnegative(),
  }),
})
export type Health = z.infer<typeof Health>

/** Error body for every non-2xx answer. `version` is set on 426. */
export const ErrorBody = z.strictObject({ error: z.string().max(2000), version: z.int().nonnegative().optional() })
export type ErrorBody = z.infer<typeof ErrorBody>
