// No raw error text in the Worker, the hub, the runner or the client error reporter (P8a P-auth). A caught error's
// message or stack can quote chat, customer, tool or file content, or a secret; logs and stored rows carry only its name
// and a known code (server/safe-error.ts, runner/src/safe-error.ts) plus fixed text we wrote. Fails on a new read of a
// caught value's `.message` or `.stack`, a `String(<caught value>)`, or a `z.prettifyError` in server/, worker/, hub/
// or runner/src/, outside the reviewed sites below. A site that is truly safe goes on the list with its reason.
// The full record: verify/backend-impl/probes/err-message-audit-verified.md (outside the repo).
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const APP = fileURLToPath(new URL('..', import.meta.url))
const ROOTS = ['server', 'worker', 'hub', 'runner/src']
const CAUGHT = String.raw`(?:e|err|error|cause|reason|thrown|last|how|ex|failed|failure)`
const RAW = [
  new RegExp(String.raw`\b${CAUGHT}\.(?:message|stack)\b`),
  new RegExp(String.raw`\bString\(\s*\(?\s*${CAUGHT}\b`),
  /\bprettifyError\(/,
]

/** Reviewed sites: [file, exact text on the line, why it's safe]. Each entry must still match a line. */
const REVIEWED: readonly (readonly [string, string, string])[] = [
  ['server/seed/run.ts', 'console.error(err instanceof Error ? err.message : err)', 'an operator CLI on a local or deploy-time database, never in the Worker'],
  ['server/seed/first-admin.ts', "err instanceof Error ? err.message : ''", 'an operator CLI; the value is the operator’s own input'],
  ['server/egress/hub.ts', 'e.message.length > HUB_MESSAGE_MAX_CHARS', "a HubError's fixed text (hub/index/errors.ts), returned to the model, never logged"],
  ['server/do/runner/runner.ts', "placementError: (e instanceof Error ? e.message : 'unknown')", "returned to pool.ts, which reads only that it's there; #up's own fixed reasons"],
  ['server/db/members.ts', '/UNIQUE constraint failed/.test(err.cause.message)', 'a match on the storage error, never logged or stored'],
  ['runner/src/proxy/server.ts', "e.message === 'upstream timeout'", "a match on our own timeout error; the log gets the fixed text"],
  ['runner/src/files/files.ts', String.raw`/^\d{3}$/.test(e.message)`, 'errnoOf: a three-digit status only'],
  ['runner/src/files/files.ts', "code: `http_${e.message}`", 'errnoOf: a three-digit status only'],
  ['runner/src/guards/host.ts', 'failed.push(String(e instanceof Error ? e.message : e))', 'thrown to users.ts, whose catch logs safeError; never logged as text'],
  ['runner/src/store/adapter.ts', 'String(e instanceof Error ? e.message : e).slice(0, 500)', "a mirror_error event's message, which the BrandAgent drops (core.ts: mirror_error sets a flag only)"],
  ['runner/src/guards/audit.ts', 'if (e instanceof Error) return e.message', "AuditRefusedError's text, thrown inside the session to the SDK hook; session stderr is dropped by the root"],
  ['runner/src/guards/audit.ts', 'return String(e)', 'as above'],
  ['runner/src/session/core.ts', 'String(e instanceof Error ? e.message : e).slice(0, 2000)', "the session's own stderr and failed events: the root drops stderr (session-host.ts keeps stack frames only) and the BrandAgent drops failed.message"],
  ['runner/src/session/core.ts', 'z.prettifyError(parsed.error)', 'as above'],
  ['runner/src/session/channel.ts', '${e.message}', 'session stderr, dropped by the root'],
  ['runner/src/protocol/local.ts', 'z.prettifyError(outer.error)', 'returned to session-host.ts, which logs a fixed reason'],
  ['runner/src/protocol/local.ts', 'z.prettifyError(body.error)', 'as above'],
  ['runner/src/server/app.ts', 'z.prettifyError(parsed.error).slice(0, 2000)', "a 400 body to the Worker's RunnerContainer, which logs the status only"],
  ['hub/connectors/shopify/test-kit.ts', 'parsed.error.message', 'a test kit, never in the deployed hub'],
]

function sources(dir: string): string[] {
  return readdirSync(join(APP, dir), { withFileTypes: true, recursive: true })
    .filter(d => d.isFile() && d.name.endsWith('.ts') && !/\.(test|spec|live)\.ts$|\.d\.ts$/.test(d.name))
    .map(d => relative(APP, join(d.parentPath, d.name)))
    .filter(f => !f.split('/').some(p => p === 'node_modules' || p === 'test' || p === 'testing'))
}

const hits = ROOTS.flatMap(sources).flatMap(file =>
  readFileSync(join(APP, file), 'utf8').split('\n').flatMap((text, i) => (RAW.some(r => r.test(text)) ? [{ file, line: i + 1, text: text.trim() }] : [])))

describe('raw error text', () => {
  it('appears only at the reviewed sites', () => {
    const unreviewed = hits.filter(h => !REVIEWED.some(([f, t]) => f === h.file && h.text.includes(t)))
    expect(unreviewed.map(h => `${h.file}:${h.line}  ${h.text}`)).toEqual([])
  })
  it('every reviewed site is still there (a stale entry would hide a new one)', () => {
    const stale = REVIEWED.filter(([f, t]) => !hits.some(h => h.file === f && h.text.includes(t)))
    expect(stale).toEqual([])
  })
  it('the patterns catch the shapes that leaked', () => {
    for (const leak of [
      "console.error({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) })",
      "deps.log({ type: 'proxy_failed', error: String(e instanceof Error ? e.stack : e) })",
      'logError(e.message)',
      "error: String((failed as PromiseRejectedResult).reason)",
      'return { ok: false, error: z.prettifyError(outer.error) }',
    ]) expect(RAW.some(r => r.test(leak)), leak).toBe(true)
    for (const safe of ["error: err instanceof Error ? err.name : 'unknown'", 'error: safeError(e)', 'mapSdkMessage(ev.message, ev.truncated)', 'String((b as { id?: unknown }).id)'])
      expect(RAW.some(r => r.test(safe)), safe).toBe(false)
  })
})
