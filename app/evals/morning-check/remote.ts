// The remote mode's runner env (run.mjs --target, and the scripted proof e2e/api/morning-check-remote.spec.ts): a deployed
// build answers, so there's no restart per case. The case's shop is the test shop override the door writes in the build's
// D1 (door.ts), the slot is read back through the same door, and the run's HTTP calls are the caller's (run.mjs mints its
// own tokens, the spec uses its kit). Route 67 (the scheduler nudge) is the test build's only, behind a release token:
// with no `alarm`, Run now's own poke and the scheduler's heartbeat move the slot, and the polls just wait (with the case's
// deadline, as ever).
import type { AccessToken } from './args.ts'
import type { MorningDoor } from './door.ts'
import type { RunnerEnv } from './runner.ts'

export interface RemoteDeps {
  door: MorningDoor
  /** Presses Run now (route 54) as a person with this key; throws on any answer but 2xx. */
  runNow(clientKey: string): Promise<void>
  /** Route 67 (`POST /api/ops/alarm`, release token, test build only); null where there's no release token (the eval build). */
  alarm: ((body: { action: 'alarm'; pokeTick?: true }) => Promise<void>) | null
  pause(): Promise<void>
  nowMs(): number
  caseTimeoutMs: number
  settleMs: number
  /** Where a loud line goes (default console.error): a leftover override found by the run's first clear. */
  warn?(line: string): void
  /**
   * Sets the brand's Default model before the first case (ensureDefaultModel), or nothing when absent. The scripted proof
   * asks for "Fast": routine turns run on the brand's Default model (Opus when unset) and the scripted model answers only
   * the Fast one. A real-model run leaves it alone (the eval run picks its own model).
   */
  defaultModel?: () => Promise<void>
  /**
   * run.mjs sets it: each case's slot model is read through the door (runner.ts modelOf), so the results carry the model
   * the turns ran on and a run whose slots ran on another model than --model stops. The scripted proof's spec leaves it out.
   */
  checkModel?: boolean
}

/**
 * The header the person JWT also travels in behind Access (main's evals/targets/product.ts TEST_ASSERTION_HEADER): Access in
 * front sets its own Cf-Access-Jwt-Assertion, so the eval build may read the test issuer's from here.
 */
export const TEST_ASSERTION_HEADER = 'X-Inhouse-Test-Assertion'

/**
 * One request's headers, as main's evals/probe.ts sends them: the person JWT in Cf-Access-Jwt-Assertion; with the eval
 * host's Access service token, the same JWT in X-Inhouse-Test-Assertion too and the token as CF-Access-Client-Id and
 * CF-Access-Client-Secret, last. Without it (a per-PR deploy) exactly today's headers.
 */
export function requestHeaders(jwt: string, origin: string, access: AccessToken | null): Record<string, string> {
  return {
    'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt, Origin: origin,
    ...(access ? { [TEST_ASSERTION_HEADER]: jwt, 'CF-Access-Client-Id': access.id, 'CF-Access-Client-Secret': access.secret } : {}),
  }
}

/** `text` with the service token's secret cut out: no answer or error the run prints or keeps can carry it. */
const scrub = (text: string, access: AccessToken | null) => (access ? text.replaceAll(access.secret, '[secret]') : text)

/**
 * run.mjs's HTTP: every request it makes to a build (Run now, route 67, the settings calls) goes through `send`, so each
 * carries requestHeaders. `send` gives the status and the body's text, a network failure rethrown with its message; `post`
 * throws on any answer but 2xx with the status and the body. Neither lets the secret into a message.
 */
export function remoteHttp(access: AccessToken | null, doFetch: typeof fetch = fetch) {
  const send = async (method: 'GET' | 'PUT' | 'POST', url: URL, jwt: string, body?: unknown): Promise<{ status: number; text: string }> => {
    try {
      const r = await doFetch(url, { method, headers: requestHeaders(jwt, url.origin, access), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: r.status, text: scrub(await r.text(), access) }
    } catch (e) {
      throw new Error(`run.mjs: ${method} ${url.pathname} failed: ${scrub(e instanceof Error ? e.message : String(e), access)}`)
    }
  }
  return {
    send,
    async post(url: URL, body: unknown, jwt: string): Promise<void> {
      const r = await send('POST', url, jwt, body)
      if (r.status < 200 || r.status > 299) throw new Error(`run.mjs: POST ${url.pathname} answered ${r.status}: ${r.text}`)
    },
  }
}

/** One API call as one identity, as the caller's HTTP gives the answer (status and parsed JSON). */
export type ApiCall = (method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: unknown }>

/**
 * Who writes the brand's Default model. Only the Inhouse team writes `g:mode` (server/auth/matrix.ts: a Member never writes
 * technical settings, an Admin only `tm:<id>:on` keys, so the Admin gets 403 admin_read_only). The Inhouse team needs no
 * grant for it: matrix.ts answers a technical row for an Inhouse principal OK (only brand_data takes a live grant), and no
 * gate before the matrix refuses one (server/api/routes-wired.test.ts writes technical `stage` as Inhouse with no grant
 * open, through the whole Worker). The grant step below only mirrors e2e/api/watch-kit.ts setStage and
 * e2e/ship/watch.spec.ts ensureFastDefault. So: the Admin (a brand person: reads, grants) and the Inhouse team member,
 * signed in on the build's Inhouse app.
 */
export interface SettingsApi {
  admin: ApiCall
  inhouse: ApiCall
}

/** A Default model label (the technical setting `g:mode`'s value): a plain word, never a path or a value with markup. */
const MODEL_LABEL = /^[A-Za-z]{1,20}$/

const fail = (what: string, r: { status: number; json: unknown }) => new Error(`morning-check: ${what} answered ${r.status}: ${JSON.stringify(r.json)}`)
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Tries to end every live support grant, as the Admin; returns what went wrong (nothing: all ended). */
async function endLiveGrants(admin: ApiCall): Promise<string[]> {
  const errors: string[] = []
  let items: { id: string; rev: number; live: boolean }[]
  try {
    const list = await admin('GET', '/api/grants')
    if (list.status !== 200) throw fail('GET /api/grants', list)
    const found = (list.json as { items?: { id: string; rev: number; live: boolean }[] } | null)?.items
    if (!Array.isArray(found)) throw new Error('morning-check: GET /api/grants has no items')
    items = found
  } catch (e) {
    return [message(e)]
  }
  for (const g of items.filter(x => x.live)) {
    try {
      const done = await admin('POST', `/api/grants/${encodeURIComponent(g.id)}/end`, { ifRev: g.rev })
      if (done.status !== 200) throw fail(`ending support grant ${g.id}`, done)
    } catch (e) {
      errors.push(message(e))
    }
  }
  return errors
}

/**
 * The brand's Default model (`g:mode`) set to `label` and read back as a brand person (route 12). When it differs: live
 * grants ended, a one-hour grant opened by the Admin (setStage's steps; the write itself needs none), the Inhouse team
 * member's PUT with the setting's own revision, every live grant ended again whatever the PUT did, then the read back.
 * Throws when any step is refused or the value doesn't read back; a write that failed and grants that wouldn't end are
 * reported together.
 */
export async function ensureDefaultModel(api: SettingsApi, label: string): Promise<void> {
  if (!MODEL_LABEL.test(label)) throw new Error(`morning-check: ${JSON.stringify(label)} is not a Default model label`)
  const read = async () => {
    const r = await api.admin('GET', '/api/settings/technical')
    if (r.status !== 200) throw fail('GET /api/settings/technical', r)
    const items = (r.json as { items?: { key: string; value?: unknown; rev?: number }[] } | null)?.items
    if (!Array.isArray(items)) throw new Error('morning-check: GET /api/settings/technical has no items')
    return items.find(i => i.key === 'g:mode')
  }
  const now = await read()
  if (now?.value !== label) {
    const before = await endLiveGrants(api.admin)
    if (before.length) throw new Error(`morning-check: live support grants could not be ended: ${before.join('; ')}`)
    let failed: unknown = null
    try {
      const grant = await api.admin('POST', '/api/grants', { hours: 1 })
      if (grant.status !== 201) throw fail('opening a support grant', grant)
      const put = await api.inhouse('PUT', '/api/settings/technical/g%3Amode', { value: label, ifRev: now?.rev ?? 0 })
      if (put.status !== 200) throw fail(`setting the Default model to ${label}`, put)
    } catch (e) {
      failed = e
    }
    const after = await endLiveGrants(api.admin)
    if (failed !== null && after.length) throw new Error(`${message(failed)}; and live support grants could not be ended: ${after.join('; ')}`, { cause: failed })
    if (failed !== null) throw failed
    if (after.length) throw new Error(`morning-check: live support grants could not be ended: ${after.join('; ')}`)
  }
  const after = await read()
  if (after?.value !== label) throw new Error(`morning-check: the Default model reads back ${JSON.stringify(after?.value)}, not ${label}`)
}

export function remoteEnv(d: RemoteDeps): RunnerEnv {
  const warn = d.warn ?? (line => console.error(line))
  let first = true
  return {
    ...(d.defaultModel ? { beforeCases: d.defaultModel } : {}),
    ...(d.checkModel ? { modelOf: (slotKey: string) => d.door.model(slotKey) } : {}),
    nowMs: d.nowMs,
    useShop: host => d.door.setShop(host),
    // runAll's first clear is the run's start: a row there is a leftover from a run that didn't clear (or one running now:
    // one runner per deployment), said loudly. Later clears remove the case's own row.
    async releaseShop() {
      const removed = await d.door.clearShop()
      if (first && removed !== null) warn(`morning-check: removed a leftover test shop override (${removed}) at the start of the run. Another run may not have cleared it, or one is running against this deployment now: only one runner per deployment.`)
      first = false
    },
    newKey: () => crypto.randomUUID().replaceAll('-', ''),
    async trigger(clientKey) {
      await d.runNow(clientKey)
      if (d.alarm) await d.alarm({ action: 'alarm', pokeTick: true })
    },
    async nudge() {
      if (d.alarm) await d.alarm({ action: 'alarm' })
    },
    pause: d.pause,
    reader: d.door,
    caseTimeoutMs: d.caseTimeoutMs,
    settleMs: d.settleMs,
  }
}

export interface SignalDeps {
  on(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void
  exit(code: number): void
  error(line: string): void
}
const processSignals: SignalDeps = { on: (s, h) => void process.once(s, h), exit: code => process.exit(code), error: line => console.error(line) }

/**
 * run.mjs's stop handlers: on SIGINT or SIGTERM the door is closed first (runAll may still be going, and its next setShop
 * must not write an override after the clear), then the override is cleared (awaited) before the process exits 130 or 143,
 * so an interrupted run leaves no override behind. A clear that fails is printed; the exit code stays the signal's.
 */
export function clearOnSignals(door: Pick<MorningDoor, 'close' | 'clearShop'>, d: SignalDeps = processSignals): void {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    d.on(signal, () => {
      door.close()
      d.error(`run.mjs: ${signal}: clearing the test shop override before exiting`)
      door.clearShop().then(
        () => d.exit(code),
        (e: unknown) => {
          d.error(`run.mjs: the test shop override could not be cleared: ${e instanceof Error ? e.message : String(e)}`)
          d.exit(code)
        },
      )
    })
  }
}
