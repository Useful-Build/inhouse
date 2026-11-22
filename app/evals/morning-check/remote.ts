// The remote mode's runner env (run.mjs --target, and the scripted proof e2e/api/morning-check-remote.spec.ts): a deployed
// build answers, so there's no restart per case. The case's shop is the test shop override the door writes in the build's
// D1 (door.ts), the slot is read back through the same door, and the run's HTTP calls are the caller's (run.mjs mints its
// own tokens, the spec uses its kit). Route 67 (the scheduler nudge) is the test build's only, behind a release token:
// with no `alarm`, Run now's own poke and the scheduler's heartbeat move the slot, and the polls just wait (with the case's
// deadline, as ever).
// The graded run (run.mjs on EVAL_DB, gradedRun below) holds the eval lease, pins the eval brand's Spending cap and its
// Default model through the door, and stops before the next case once the run has spent its --budget.
import type { MemoryDoor } from '../targets/door.ts'
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
  /** The graded run's check before each case (gradedRun's beforeCase): a reason stops the run there. */
  beforeCase?: () => Promise<string | null>
}

/**
 * The eval brand's Spending cap for the morning-check graded run: the product eval's own (targets/product.ts EVAL_CAP, a
 * test pins the two equal). Written as one literal line: ops eval-gate matches it.
 */
export const MORNING_CHECK_CAP = '$50'

/**
 * run.mjs's HTTP: every request it makes to a build (Run now, route 67, the settings and usage calls) goes through `send`:
 * the caller's sign-in headers (targets/product.ts testIssuerSignIn, or route 67's release token), then `edge`, the eval
 * host's Access service token (targets/product.ts accessHeaders; empty on a per-PR deploy), last. `send` gives the status
 * and the body's text, a network failure rethrown with its message; `post` throws on any answer but 2xx with the status
 * and the body. Neither lets an `edge` value (the secret) into a message.
 */
export function remoteHttp(edge: Record<string, string>, doFetch: typeof fetch = fetch) {
  const hidden = Object.values(edge).filter(v => v !== '')
  const scrub = (text: string) => hidden.reduce((t, v) => t.replaceAll(v, '[secret]'), text)
  const send = async (method: 'GET' | 'PUT' | 'POST', url: URL, auth: Record<string, string>, body?: unknown): Promise<{ status: number; text: string }> => {
    try {
      const r = await doFetch(url, { method, headers: { 'Content-Type': 'application/json', ...auth, Origin: url.origin, ...edge }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: r.status, text: scrub(await r.text()) }
    } catch (e) {
      throw new Error(`run.mjs: ${method} ${url.pathname} failed: ${scrub(e instanceof Error ? e.message : String(e))}`)
    }
  }
  return {
    send,
    async post(url: URL, body: unknown, auth: Record<string, string>): Promise<void> {
      const r = await send('POST', url, auth, body)
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
    ...(d.beforeCase ? { beforeCase: d.beforeCase } : {}),
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
export function clearOnSignals(door: Pick<MorningDoor, 'close' | 'clearShop'>, d: SignalDeps = processSignals, release?: () => Promise<void>): void {
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e))
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    d.on(signal, () => {
      door.close()
      d.error(`run.mjs: ${signal}: clearing the test shop override before exiting`)
      // The graded run's eval lease is given back after the clear, whatever the clear did (`release`).
      const giveBack = () => (release ? release().catch((e: unknown) => d.error(`run.mjs: the eval lease could not be given back: ${said(e)}`)) : Promise.resolve())
      door.clearShop().then(
        () => giveBack().then(() => d.exit(code)),
        (e: unknown) => {
          d.error(`run.mjs: the test shop override could not be cleared: ${said(e)}`)
          void giveBack().then(() => d.exit(code))
        },
      )
    })
  }
}

/** The graded run's door: the eval lease, the test shop override's read, the cap and the Default model (targets/door.ts). */
export type GradedDoor = Pick<MemoryDoor, 'hasChat' | 'takeLease' | 'releaseLease' | 'testShop' | 'setSpendingCap' | 'setDefaultModel'>

export interface GradedDeps {
  door: GradedDoor
  /** The seeded Admin on --target: route 42 (`GET /api/usage`, the Usage page's numbers) and the probe chat (route `POST /api/chats`). */
  admin: ApiCall
  /** This run's eval lease tag. */
  tag: string
  /** The Default model label --model maps to (args.ts defaultModelLabel). */
  label: string
  budgetUsd: number
  /** The probe chat's id (default: a fresh `eval-probe-<hex>`). */
  probeId?: () => string
}

export interface GradedRun {
  /**
   * Before runAll: takes the eval lease, proves --target answers from this door's database (a probe chat made through the
   * API is read back through the door, as targets/product.ts does), refuses a test shop override this run didn't write (a
   * morning-check run is on the deployment or one left it), pins MORNING_CHECK_CAP and reads it back on route 42 (a month at the cap refuses), notes
   * the month's spend as the run's start, then sets the Default model to `label`.
   */
  start(): Promise<void>
  /**
   * Before each case: renews the lease; a reason when the run has spent its --budget, the month reached the cap, or the
   * month rolled over (the month's total fell below the run's start, so the run's spend can't be read).
   */
  beforeCase(): Promise<string | null>
  /** Gives the lease back if this run took it, waiting for a take still in flight (a signal during start). */
  release(): Promise<void>
}

/**
 * The month's spend and the cap from route 42, in dollars, as targets/product.ts room() reads them: the cap must still be
 * MORNING_CHECK_CAP (a re-seed or a Settings change can't lift it silently).
 */
async function usage(admin: ApiCall): Promise<{ spentUsd: number; capUsd: number }> {
  const u = await admin('GET', '/api/usage')
  if (u.status !== 200) throw new Error(`morning-check: GET /api/usage answered ${u.status}`)
  const j = u.json as { total?: { minor?: unknown }; cap?: { minor?: unknown } } | null
  const cents = (m: unknown, what: string) => {
    if (!Number.isInteger(m)) throw new Error(`morning-check: route 42 gave no ${what}`)
    return (m as number) / 100
  }
  const r = { spentUsd: cents(j?.total?.minor, 'total'), capUsd: cents(j?.cap?.minor, 'cap') }
  if (Math.round(r.capUsd * 100) !== Number(MORNING_CHECK_CAP.slice(1)) * 100) throw new Error(`morning-check: refusing: the brand's Spending cap is not ${MORNING_CHECK_CAP} (route 42 says $${r.capUsd.toFixed(2)})`)
  return r
}

export function gradedRun(g: GradedDeps): GradedRun {
  let leased = false
  let taking: Promise<void> | null = null
  let startUsd: number | null = null
  const capUsd = Number(MORNING_CHECK_CAP.slice(1))
  return {
    async start() {
      taking = g.door.takeLease(g.tag).then(() => { leased = true })
      await taking
      // --target must answer from the door's database (EVAL_DB): a chat made there is read back here, or nothing is set.
      const probe = g.probeId?.() ?? `eval-probe-${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`
      const made = await g.admin('POST', '/api/chats', { id: probe, title: 'Eval probe' })
      if (made.status !== 200 && made.status !== 201) throw new Error(`morning-check: refusing: --target did not make the probe chat (POST /api/chats answered ${made.status})`)
      if (!(await g.door.hasChat(probe))) throw new Error('morning-check: refusing: the door\'s database does not hold the chat --target just made, so --target is not the eval deployment the door writes to')
      const shop = await g.door.testShop()
      if (shop !== null) throw new Error(`morning-check: refusing: a test shop override (hub:shop ${shop}) is already set on the eval deployment and this run didn't write it: another morning-check run is on it or left it (clear it through the door once none runs)`)
      await g.door.setSpendingCap(MORNING_CHECK_CAP)
      const { spentUsd } = await usage(g.admin)
      if (spentUsd >= capUsd) throw new Error(`morning-check: refusing: this month's spend ($${spentUsd.toFixed(2)}) has reached the ${MORNING_CHECK_CAP} cap`)
      startUsd = spentUsd
      await g.door.setDefaultModel(g.label)
    },
    async beforeCase() {
      if (startUsd === null) throw new Error('morning-check: the graded run was not started')
      await g.door.takeLease(g.tag)
      const { spentUsd } = await usage(g.admin)
      if (spentUsd < startUsd) return `the month rolled over during the run (route 42's total $${spentUsd.toFixed(2)} is below the $${startUsd.toFixed(2)} at its start), so its spend can't be read: it stops before the next case`
      const run = spentUsd - startUsd
      if (run >= g.budgetUsd) return `the run has spent $${run.toFixed(2)} (route 42, since its start), reaching its --budget $${g.budgetUsd.toFixed(2)}, so it stops before the next case`
      if (spentUsd >= capUsd) return `this month's spend ($${spentUsd.toFixed(2)}) has reached the ${MORNING_CHECK_CAP} cap, so the run stops before the next case`
      return null
    },
    async release() {
      await taking?.catch(() => {})
      if (leased) await g.door.releaseLease(g.tag)
      leased = false
    },
  }
}
