// No raw error text in the Worker, the hub, the runner, the shared code or the client error reporter (P8a P-auth). A
// caught error's message or stack can quote chat, customer, tool or file content, or a secret; logs and stored rows carry
// only its name and a known code (server/safe-error.ts, runner/src/safe-error.ts) plus fixed text we wrote. Two checks
// over server/, worker/, hub/, shared/ and runner/src/, each with the reviewed sites below:
//  1. line shapes that put an error's text somewhere: dot or bracket reads of message/stack (including casts and
//     non-null assertions), `${err}`, concatenation,
//     `String(err)`, `console.x(err)`, `{ error: err }` (Workers Logs serialises an Error's message and stack),
//     `const { message } = err`, `err.toString()`, `(x as PromiseRejectedResult).reason`, `z.prettifyError`;
//  2. every catch binding (`catch (x)`, `.catch((x) =>`, `.then(ok, (x) =>`, `.on('error', (x) =>`), whatever its name:
//     inside its body, any use other than `safeError(x)`, `errnoOf(x)`, `reasonOf(x)`, `throw x`, `x instanceof`, `x.name`, `x.code` or
//     `(x as T).code`.
// A site that is truly safe goes on the list with its reason. The full record:
// verify/backend-impl/probes/err-message-audit-verified.md (outside the repo).
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['server', 'worker', 'hub', 'shared', 'runner/src']
const CAUGHT = String.raw`(?:e|err|error|cause|reason|thrown|last|how|ex|failed|failure)`
const ERROR_TEXT = String.raw`\s*!?\s*(?:\??\.\s*(?:message|stack)\b|(?:\?\.)?\[\s*(['"\x60])(?:message|stack)\1\s*\])`
const RAW = [
  new RegExp(String.raw`\b${CAUGHT}(?:\??\.cause)*${ERROR_TEXT}`),
  new RegExp(String.raw`\)${ERROR_TEXT}`),
  new RegExp(String.raw`(?:['"\x60]\s*\+\s*\b${CAUGHT}(?![\w.?!\[])|\b${CAUGHT}\s*\+\s*['"\x60])`),
  new RegExp(String.raw`\bString\(\s*\(?\s*${CAUGHT}\b`),
  new RegExp(String.raw`\$\{\s*${CAUGHT}\s*\}`),
  new RegExp(String.raw`console\.\w+\(\s*${CAUGHT}\s*[,)]`),
  new RegExp(String.raw`:\s*${CAUGHT}\s*[,}]`),
  new RegExp(String.raw`\{[^}]*\b(?:message|stack)\b[^}]*\}\s*=\s*${CAUGHT}\b`),
  new RegExp(String.raw`\b${CAUGHT}\??\.toString\(`),
  /\bprettifyError\(/,
  /(?<!(?:safeError|errnoOf|reasonOf)\()\(\w+ as PromiseRejectedResult\)\??\.reason\b/,
]

/** Reviewed sites: [file, exact text on the line, why it's safe]. Each entry must still match a hit. */
const REVIEWED: readonly (readonly [string, string, string])[] = [
  ['server/seed/run.ts', 'console.error(err instanceof Error ? err.message : err)', 'an operator CLI on a local or deploy-time database, never in the Worker'],
  ['server/seed/first-admin.ts', "err instanceof Error ? err.message : ''", "an operator CLI; the value is the operator's own input"],
  ['server/egress/hub.ts', 'e.message.length > HUB_MESSAGE_MAX_CHARS', "a HubError's fixed text (hub/index/errors.ts), returned to the model, never logged"],
  ['server/outbox/hub-call.ts', 'const partial = partialOf(r.error.code, r.error.message)', "a WriteResult's HubError text (not a caught error), matched against the order-number groups only; only digits are kept, anything else is dropped"],
  ['server/db/members.ts', '/UNIQUE constraint failed/.test(err.cause.message)', 'a match on the storage error, never logged or stored'],
  ['server/db/sql.ts', 'throw err instanceof StoreUnavailableError ? err : new StoreUnavailableError(what, err)', 'kept as the cause only; the message is fixed text'],
  ['server/usage/ledger.ts', "new StoreUnavailableError('usage ledger', err)", 'as above'],
  ['server/api.ts', "err.reason ? { reason: err.reason } : {}", "AccessRefusedError's reason, a fixed code of ours"],
  ['server/auth/authenticate.ts', 'if (isKeySetFailure(err))', 'a type test, nothing kept'],
  ['server/egress/model.ts', 'c.error(e)', "errors the model stream for the session's own SDK; never logged"],
  ['server/routines/tick.ts', 'return failedOnce(db, k.slot_key, now, err)', 'failedOnce logs safeError(err)'],
  ['server/routines/tick.ts', 'return failedOnce(db, s.slot_key, now, err)', 'as above'],
  ['server/do/brand-agent/scheduler.ts', 'failure ??= err', 'kept to rethrow from settled(); its log is safeError'],
  ['server/do/runner/runner.ts', 'last = e', 'read through reasonOf only'],
  ['shared/protocol/index.ts', "message: e instanceof Error ? e.message : 'not a run event'", "a PushBatch schema issue; the events route answers a fixed 'invalid' (server/egress/events.ts) and logs none of it"],
  ['runner/src/files/files.ts', String.raw`/^\d{3}$/.test(e.message)`, 'errnoOf: a three-digit status only'],
  ['runner/src/files/files.ts', 'code: `http_${e.message}`', 'errnoOf: a three-digit status only'],
  ['runner/src/files/safe-dir.ts', 'if (refusedLink(e)) throw new NotFollowed(path)', 'a code test, nothing kept'],
  ['runner/src/store/adapter.ts', 'String(e instanceof Error ? e.message : e).slice(0, 500)', "a mirror_error event's message, which the BrandAgent drops (core.ts: mirror_error sets a flag only)"],
  ['runner/src/store/adapter.ts', '${errorText(e)}', 'as above'],
  ['runner/src/guards/audit.ts', 'if (e instanceof Error) return e.message', "AuditRefusedError's text, thrown inside the session to the SDK hook; session stderr is dropped by the root"],
  ['runner/src/guards/audit.ts', 'return String(e)', 'as above'],
  ['runner/src/guards/audit.ts', '(${describe(e)})', 'as above'],
  ['runner/src/session/core.ts', 'String(e instanceof Error ? e.message : e).slice(0, 2000)', "the session's own stderr and failed events: the root drops stderr (session-host.ts keeps stack frames only) and the BrandAgent drops failed.message"],
  ['runner/src/session/core.ts', 'z.prettifyError(parsed.error)', 'as above'],
  ['runner/src/session/core.ts', "setupFailed('guards', e)", 'as above (session stderr)'],
  ['runner/src/session/core.ts', "setupFailed('outputs_snapshot', e)", 'as above (session stderr)'],
  ['runner/src/session/core.ts', 'thrown = e', "becomes a failed event's message, which the BrandAgent drops"],
  ['runner/src/session/channel.ts', '${e.message}', 'session stderr, dropped by the root'],
  ['runner/src/protocol/local.ts', 'z.prettifyError(outer.error)', 'returned to session-host.ts, which logs a fixed reason'],
  ['runner/src/protocol/local.ts', 'z.prettifyError(body.error)', 'as above'],
  ['runner/src/server/app.ts', 'z.prettifyError(parsed.error).slice(0, 2000)', "a 400 body to the Worker's RunnerContainer, which logs the status only"],
  ['server/files-io/bytes.ts', '(e: unknown) => ({ ok: false, e }),', "returned as `failed`, which files-io/store.ts rethrows; every log above it is safeError"],
  ['runner/src/files/files.ts', "(e) => (signal.removeEventListener('abort', onAbort), rej(e)),", 'passed through to the caller unchanged'],
  ['server/notify-slack/send.ts', 'const suffix = e.message.includes', 'HubResult data, matched only against fixed delivery detail codes before use'],
  ['server/ops/test-fakes.ts', "return refuse(400, 'invalid', r.error.message)", 'a typed hub refusal returned by the release-only test hook'],
  ['server/ops/test-fakes.ts', "body.error?.message ?? 'no result'", 'a typed MCP refusal returned by the release-only test hook'],
  ['hub/codemode/api.ts', "const withField = hubError('invalid_args', FIELD_NOT_ALLOWED).message", 'a fixed hub contract string'],
  ['hub/codemode/api.ts', 'e.message === withField', 'compares a HubResult message to fixed text, returning only fixed text'],
  ['hub/codemode/run.ts', "settled = { kind: 'error', error }", 'passes to the bounded errorText returned to the calling model only'],
  ['hub/codemode/script.ts', 'const m = (e as { message?: unknown }).message', 'a bounded script failure returned to the calling model, never logged'],
  ['hub/registry/registry.ts', 'result.error.message === hubError', 'matches against fixed rate-limit hints and returns only a fixed hint'],
  ['hub/connectors/shopify/test-kit.ts', 'parsed.error.message', 'a test kit, never in the deployed hub'],
  ['server/egress/deny.ts', 'e => console.log(e)', '`e` is the structured log entry, not an error'],
  ['server/egress/webfetch.ts', 'log: e => console.log(e)', 'as above'],
  ['server/egress/http.ts', 'const m = body?.error?.message', "the model API's invalid_request_error text, passed back to the session's own SDK, never logged"],
  ['server/today/ids.ts', '${cause}', 'a CardCause code'],
  ['server/do/brand-agent/gate.ts', '{ refused: reason }', "refusalOf's fixed refusal code"],
  ['server/do/brand-agent/runs-read.ts', '${failed} of ${ended} failed', 'counts'],
  ['worker/client-error.ts', 'const stack = (input as { stack?: unknown }).stack', 'read only for frames that pass the same-origin code-location filter (loggedReport)'],
  ['runner/src/guards/webfetch.ts', 'permissionDecisionReason: reason', "a deny reason we wrote, to the session's own SDK"],
  ['runner/src/server/session-host.ts', 'the session process ended (${how})', 'an exit code or signal, in a failed event whose message the BrandAgent drops'],
  ['runner/src/session/core.ts', '(m as { message?: { content?: unknown } }).message?.content', "an SDK message's content, not an error"],
  ['runner/src/session/core.ts', 'new Error(`audit refused: ${error}`)', "the root's audit nack text, inside the session (stderr dropped)"],
]

function sources(dir: string): string[] {
  return readdirSync(join(APP, dir), { withFileTypes: true, recursive: true })
    .filter(d => d.isFile() && d.name.endsWith('.ts') && !/\.(test|spec|live)\.ts$|\.d\.ts$/.test(d.name))
    .map(d => relative(APP, join(d.parentPath, d.name)))
    .filter(f => !f.split('/').some(p => p === 'node_modules' || p === 'test' || p === 'testing'))
}

/** The index of the bracket closing the one at `open` (strings and line comments skipped). */
function closing(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (ch === "'" || ch === '"') {
      for (i++; i < src.length && src[i] !== ch && src[i] !== '\n'; i++) if (src[i] === '\\') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (ch === '{' || ch === '(') depth++
    else if ((ch === '}' || ch === ')') && --depth === 0) return i
  }
  return src.length
}

const ALLOWED_BEFORE = /(?:\b(?:safeError|errnoOf|reasonOf)\(\s*|\bthrow\s+)$/
const ALLOWED_AFTER = /^(?:\s+instanceof\b|\??\.(?:name|code)\b)/
const ALLOWED_CAST = /^\s+as\s+[^)]+\)\??\.code\b/

/** The lines where a catch binding is used other than by name and code. */
function catchUses(src: string): number[] {
  const bodies: { name: string; from: number; to: number }[] = []
  for (const m of src.matchAll(/\bcatch\s*\(\s*(\w+)\s*(?::\s*\w+\s*)?\)\s*\{/g)) {
    const open = m.index + m[0].length - 1
    bodies.push({ name: m[1]!, from: open + 1, to: closing(src, open) })
  }
  for (const m of src.matchAll(/\.(?:catch\(|on\(\s*'error'\s*,)\s*(?:async\s*)?\(?\s*(\w+)\s*(?::\s*\w+\s*)?\)?\s*=>/g)) {
    bodies.push({ name: m[1]!, from: m.index + m[0].length, to: closing(src, src.indexOf('(', m.index)) })
  }
  // `.then(ok, (x) => ...)`: the second callback is a catch too.
  for (const m of src.matchAll(/\.then\(/g)) {
    const open = m.index + m[0].length - 1
    const close = closing(src, open)
    let depth = 0
    let comma = -1
    for (let i = open; i < close && comma < 0; i++) {
      const ch = src[i]
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') depth--
      else if (ch === ',' && depth === 1) comma = i
    }
    if (comma < 0) continue
    const second = /^\s*(?:async\s*)?\(?\s*(\w+)\s*(?::\s*\w+\s*)?\)?\s*=>/.exec(src.slice(comma + 1, close))
    if (second) bodies.push({ name: second[1]!, from: comma + 1 + second[0].length, to: close })
  }
  const lines: number[] = []
  for (const b of bodies) {
    for (const u of src.slice(b.from, b.to).matchAll(new RegExp(String.raw`\b${b.name}\b`, 'g'))) {
      const at = b.from + u.index
      const before = src.slice(Math.max(0, at - 30), at)
      const after = src.slice(at + b.name.length, at + b.name.length + 60)
      if (ALLOWED_BEFORE.test(before) || ALLOWED_AFTER.test(after) || (/\(\s*$/.test(before) && ALLOWED_CAST.test(after))) continue
      lines.push(src.slice(0, at).split('\n').length)
    }
  }
  return lines
}

/** Every flagged line of `src`, by either check. */
function flagged(src: string): number[] {
  const byShape = src.split('\n').flatMap((text, i) => (RAW.some(r => r.test(text)) ? [i + 1] : []))
  return [...new Set([...byShape, ...catchUses(src)])].sort((a, b) => a - b)
}

const hits = ROOTS.flatMap(sources).flatMap(file => {
  const src = readFileSync(join(APP, file), 'utf8')
  const lines = src.split('\n')
  return flagged(src).map(line => ({ file, line, text: lines[line - 1]!.trim() }))
})

describe('raw error text', () => {
  it('appears only at the reviewed sites', () => {
    const unreviewed = hits.filter(h => !REVIEWED.some(([f, t]) => f === h.file && h.text.includes(t)))
    expect(unreviewed.map(h => `${h.file}:${h.line}  ${h.text}`)).toEqual([])
  })
  it('every reviewed site is still there (a stale entry would hide a new one)', () => {
    const stale = REVIEWED.filter(([f, t]) => !hits.some(h => h.file === f && h.text.includes(t)))
    expect(stale).toEqual([])
  })
  it('catches the shapes that leaked or could', () => {
    for (const leak of [
      "console.error({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })",
      "deps.log({ type: 'proxy_failed', error: String(e instanceof Error ? e.stack : e) })",
      'logError(e.message)',
      'error: String((failed as PromiseRejectedResult).reason)',
      'return { ok: false, error: z.prettifyError(outer.error) }',
      'log(`failed: ${e}`)',
      'console.error(err)',
      "console.warn(e, 'more')",
      "log({ event: 'x', error: err })",
      'log({ error: err, at })',
      'const text = (e as Error).message',
      'const s = (err as NodeJS.ErrnoException).stack',
      'const { message } = err',
      'const { name, stack } = e',
      'log(err?.toString())',
      'log(e?.message)',
      'log(err!.message)',
      'log(err.cause?.stack)',
      'log(err?.["message"])',
      "log((problem as Error)['stack'])",
      'log(err[`message`])',
      'log("failed: " + err)',
      'log(err + " failed")',
      'log({ error: (bad as PromiseRejectedResult).reason })',
    ]) expect(flagged(leak), leak).toEqual([1])
    for (const safe of ["error: err instanceof Error ? err.name : 'unknown'", 'error: safeError(e)', 'mapSdkMessage(ev.message, ev.truncated)', 'String((b as { id?: unknown }).id)', 'error: safeError((failed as PromiseRejectedResult).reason)'])
      expect(flagged(safe), safe).toEqual([])
  })
  it('follows a catch binding of any name', () => {
    const src = [
      'try { go() } catch (oops) {',
      '  log({ error: safeError(oops), name: oops.name })',
      "  if ((oops as NodeJS.ErrnoException).code === 'ENOENT') return",
      '  if (oops instanceof TypeError) throw oops',
      '  report(oops)',
      '}',
      "p.catch((boom: unknown) => send({ detail: describe(boom) }))",
      "sock.on('error', (problem) => write(problem))",
      'p.catch(() => undefined)',
      'p.then(ok, (boom) => log({ error: boom }))',
      'p.then((v) => use(v), (boom: unknown) => { if (boom instanceof Error) throw boom })',
    ].join('\n')
    expect(catchUses(src)).toEqual([5, 7, 8, 10])
  })
})
