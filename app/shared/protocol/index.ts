// The Worker <-> runner wire protocol (P3). One schema set, parsed by the Worker with the app's zod and by the root
// runner with the runner's own zod (the zod-major check keeps them one dialect).
//
// Unknown fields: every object here is strict, so a field the other side doesn't know fails the parse loudly. Any change
// to a schema bumps PROTOCOL_VERSION; a side that still accepts the previous version keeps that version's schemas.
// The one open shape is the SDK message inside an `sdk` event, passed through as data.
import { z } from 'zod'

export const PROTOCOL_VERSION = 1
/**
 * The versions this side speaks. The rule: the current one and the one before, so a Worker one version ahead still runs
 * chats. There's no version before 1, so this is `[1]`; when v2 lands it becomes `[2, 1]`.
 */
export const ACCEPTED_VERSIONS: readonly number[] = [PROTOCOL_VERSION]
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
/**
 * The runner's cap on a `POST /runs` body, in bytes. JSON can escape one prompt character as six bytes (`\u0000`), so
 * the cap fits a prompt at its cap written that way, plus every other field at its own cap (checked in wire.test.ts).
 */
export const RUN_START_MAX_BYTES = 2 * 1024 * 1024

/** The fields of a `POST /runs` body; `RunStart` adds the cross-field rules. */
export const RunStartFields = z.strictObject({
  runId: Id,
  chatId: Id,
  sessionId: SessionId,
  /** false on a session's first run (`sessionId`), true after (`resume`). */
  resume: z.boolean(),
  /** `""` resumes after a deferred tool call's answer, so it's allowed only with `resume: true`. */
  prompt: z.string().max(PROMPT_MAX_CHARS),
  model: z.string().regex(/^[A-Za-z0-9._:@/-]{1,128}$/),
  effort: Effort,
  maxTurns: z.int().min(1).max(500),
  maxBudgetUsd: z.number().positive().max(1000),
  runToken: z.string().regex(/^[\x21-\x7e]{16,512}$/),
  webFetchDomains: z.array(Hostname).max(200),
  fileCaps: FileCaps,
})

/** Cross-field rules shared by `RunStart` and the runner's run config (the same fields less the token). */
export function checkRunStart(v: { prompt: string; resume: boolean }, ctx: z.RefinementCtx) {
  if (v.prompt === '' && !v.resume) ctx.addIssue({ code: 'custom', path: ['prompt'], message: 'an empty prompt is only for a resume' })
}

/** `POST /runs` body. The run token is accepted here and nowhere else. */
export const RunStart = RunStartFields.superRefine(checkRunStart)
export type RunStart = z.infer<typeof RunStart>

/** The largest SDK message passed through whole in an `sdk` event; a bigger one arrives as a stub with `truncated`. */
export const SDK_MESSAGE_MAX_BYTES = 256 * 1024

/** `files`: the chat's files couldn't be brought into the work folder, so the run didn't start its query. */
export const FailureReason = z.enum(['session_crashed', 'protocol', 'store', 'files', 'interrupted', 'stopped', 'timeout', 'sdk_error'])
export type FailureReason = z.infer<typeof FailureReason>

/** `bad_name`: a name the files route can't carry (a `#` or `\`, a `.` or `..` segment, an unpaired surrogate). */
export const FileRefusalReason = z.enum(['too_large', 'too_many', 'type_not_allowed', 'save_failed', 'bad_name'])

/** Caps on the open shapes a session sends, as JSON bytes. An event over one fails the parse (`protocol`). */
export const DEFERRED_INPUT_MAX_BYTES = 64 * 1024
export const USAGE_MAX_BYTES = 32 * 1024

const utf8 = new TextEncoder()

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
 * One entry of the blocking audit log (R2's hook builds them). The session sends it to the root, which writes it as an
 * `audit` run event on the Worker's open stream before it acks; the hook's call goes ahead only on that ack.
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

const FilePath = z.string().max(1024)

const Usage = z.record(z.string(), z.unknown()).refine((u) => jsonBytes(u) <= USAGE_MAX_BYTES, { message: `usage over ${USAGE_MAX_BYTES} bytes` })

/** A run event without its envelope. The root runner stamps `runId` and `seq`. */
export const RunEventBody = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('started'), sessionId: SessionId, resume: z.boolean() }),
  z.strictObject({
    type: z.literal('sdk'),
    /** The SDK message as data. When `truncated`, only `type`, `subtype` and `bytes` are kept. */
    message: z.record(z.string(), z.unknown()),
    truncated: z.boolean(),
  }),
  z.strictObject({ type: z.literal('file_saved'), path: FilePath, bytes: z.int().nonnegative(), contentType: z.string().max(128) }),
  z.strictObject({ type: z.literal('file_refused'), path: FilePath, reason: FileRefusalReason, bytes: z.int().nonnegative().optional() }),
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
  z.strictObject({
    type: z.literal('deferred'),
    toolUseId: z.string().max(256),
    toolName: z.string().max(256),
    input: z.unknown().refine((i) => jsonBytes(i) <= DEFERRED_INPUT_MAX_BYTES, { message: `input over ${DEFERRED_INPUT_MAX_BYTES} bytes` }),
  }),
  /** The store confirmed every batch of this run (`entries` uuids checked with `load()`). */
  z.strictObject({ type: z.literal('checkpoint'), entries: z.int().nonnegative() }),
  z.strictObject({
    type: z.literal('finished'),
    subtype: z.string().max(64),
    isError: z.boolean(),
    numTurns: z.int().nonnegative(),
    costUsd: z.number().nonnegative(),
    usage: Usage,
  }),
  z.strictObject({ type: z.literal('failed'), reason: FailureReason, message: z.string().max(2000) }),
])
export type RunEventBody = z.infer<typeof RunEventBody>

const RunEventEnvelope = z.strictObject({ runId: Id, seq: z.int().nonnegative() })

/** One line of the `POST /runs` NDJSON stream: the body plus `runId` and `seq` (from 0 per run, no gaps). */
export type RunEvent = z.infer<typeof RunEventEnvelope> & RunEventBody

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
