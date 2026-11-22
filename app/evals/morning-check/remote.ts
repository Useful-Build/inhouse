// The remote mode's runner env (run.mjs --target, and the scripted proof e2e/api/morning-check-remote.spec.ts): a deployed
// build answers, so there's no restart per case. The case's shop is the test shop override the door writes in the build's
// D1 (door.ts), the slot is read back through the same door, and the run's HTTP calls are the caller's (run.mjs mints its
// own tokens, the spec uses its kit). Route 67 (the scheduler nudge) is the test build's only, behind a release token:
// with no `alarm`, Run now's own poke and the scheduler's heartbeat move the slot, and the polls just wait (with the case's
// deadline, as ever).
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
}

/** One API call as one identity, as the caller's HTTP gives the answer (status and parsed JSON). */
export type ApiCall = (method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: unknown }>

/**
 * Who writes the brand's Default model. Only the Inhouse team writes `g:mode` (server/auth/matrix.ts: a Member never writes
 * technical settings, an Admin only `tm:<id>:on` keys, so the Admin gets 403 admin_read_only), under a live support grant
 * an Admin opens. So: the Admin (a brand person: reads, grants) and the Inhouse team member, signed in on the build's
 * Inhouse app. Mirrors e2e/api/watch-kit.ts setStage and e2e/ship/watch.spec.ts ensureFastDefault.
 */
export interface SettingsApi {
  admin: ApiCall
  inhouse: ApiCall
}

/** A Default model label (the technical setting `g:mode`'s value): a plain word, never a path or a value with markup. */
const MODEL_LABEL = /^[A-Za-z]{1,20}$/

const fail = (what: string, r: { status: number; json: unknown }) => new Error(`morning-check: ${what} answered ${r.status}: ${JSON.stringify(r.json)}`)

/** Ends every live support grant, as the Admin (each end must succeed). */
async function endLiveGrants(admin: ApiCall): Promise<void> {
  const list = await admin('GET', '/api/grants')
  if (list.status !== 200) throw fail('GET /api/grants', list)
  const items = (list.json as { items?: { id: string; rev: number; live: boolean }[] } | null)?.items
  if (!Array.isArray(items)) throw new Error('morning-check: GET /api/grants has no items')
  for (const g of items.filter(x => x.live)) {
    const done = await admin('POST', `/api/grants/${encodeURIComponent(g.id)}/end`, { ifRev: g.rev })
    if (done.status !== 200) throw fail(`ending support grant ${g.id}`, done)
  }
}

/**
 * The brand's Default model (`g:mode`) set to `label` and read back as a brand person (route 12). When it differs: live
 * grants ended, a one-hour grant opened by the Admin, the Inhouse team member's PUT with the setting's own revision, the
 * grants ended again (whatever the PUT answered), then the read back. Throws when any step is refused or the value doesn't
 * read back; no grant is left open by it.
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
    await endLiveGrants(api.admin)
    let put: { status: number; json: unknown }
    try {
      const grant = await api.admin('POST', '/api/grants', { hours: 1 })
      if (grant.status !== 201) throw fail('opening a support grant', grant)
      put = await api.inhouse('PUT', '/api/settings/technical/g%3Amode', { value: label, ifRev: now?.rev ?? 0 })
    } finally {
      await endLiveGrants(api.admin)
    }
    if (put.status !== 200) throw fail(`setting the Default model to ${label}`, put)
  }
  const after = await read()
  if (after?.value !== label) throw new Error(`morning-check: the Default model reads back ${JSON.stringify(after?.value)}, not ${label}`)
}

export function remoteEnv(d: RemoteDeps): RunnerEnv {
  const warn = d.warn ?? (line => console.error(line))
  let first = true
  return {
    ...(d.defaultModel ? { beforeCases: d.defaultModel } : {}),
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
