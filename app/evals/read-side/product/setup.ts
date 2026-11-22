// Wires the read-side product target to a deployment, in one of two modes:
//   - eval (the paid run, cli.ts --target product): the eval deployment only. Its database is EVAL_DB (targets/door.ts eval
//     rule), its bucket the constant EVAL_BUCKET, its chats targets/product.ts's own (eval-brand check, lease, case persons,
//     the $50 cap);
//   - proof (the scripted proof, e2e/api/read-side-remote.spec.ts): a PR's test deployment only. No spend flag exists in this
//     mode; the database must be exactly `inhouse-sbx-pr<N>-db` (and answer for the deployment: a probe chat read back) and the
//     bucket `inhouse-sbx-pr<N>-files`; /api/me must not say evalBrand (the eval build) while the test issuer signs in (only
//     the test and eval builds trust it), so it is the test build and its scripted model.
// Both run the same preflight before any spend: sign-in, the database (every reader's statement with LIMIT 0), the bucket, the
// page origin's known page when web cases run; eval adds the lease, the cap and the month's room for the budget, then pins
// the effort. The run's close exists before the first step and is handed to `register` at once, so a stop at any point gives
// back what was taken so far: the live session first (its turns stopped), then the routines made since the start, the shop
// override, the effort and the lease. close() is one promise: a second call (a signal during the final close) awaits the same work.
import { randomBytes } from 'node:crypto'
import { renderPage } from '../pages.ts'
import type { ReadSideCase } from '../cases.ts'
import { READ_SIDE_CASES } from '../cases.ts'
import { READ_SIDE_CAP_USD } from '../args.ts'
import { readSideShopOf } from '../shops.ts'
import { createMorningDoor, type MorningDoor } from '../../morning-check/door.ts'
import { createDoor, D1_NOW_MS, DoorRefusal, PER_PR_DB, wranglerRunner, type MemoryDoor, type RunSql } from '../../targets/door.ts'
import {
  accessHeaders, casePerson, createProductTarget, EVAL_ACCESS_CLIENT_ID_VAR, EVAL_ACCESS_CLIENT_SECRET_VAR, EVAL_AUD_VAR, EVAL_BRAND_FLAG,
  EVAL_CAP, EVAL_D1_NAME, EVAL_ISSUER_JWK_FILE, EVAL_ORIGIN_VAR, EVAL_PEOPLE, EVAL_WRANGLER_CONFIG, productSession, testIssuerSignIn, type Api,
} from '../../targets/product.ts'
import { SEED_INHOUSE } from '../../../server/seed/brand.ts'
import { EVAL_BUCKET } from '../../exfiltration/store-data/transcripts.ts'
import type { ExfilSpec, PersonKey, RunContext, SeedFact, Session } from '../../types.ts'
import { pinEffort, type SettingsApi } from './effort.ts'
import { EXTRACT_CAPS } from './extract.ts'
import { createSessionReader, type SessionReader } from './r2.ts'
import { createRowReader } from './rows.ts'
import { createProductReadSideTarget, deleteRoutines, SINCE_MARGIN_MS, type ProductTarget, type RawApi, type ProductDeps } from './target.ts'

/** The Inhouse app's origin and Access aud on the eval deployment: the effort is a technical setting only the Inhouse team writes. */
export const EVAL_INHOUSE_ORIGIN_VAR = 'INHOUSE_EVAL_INHOUSE_ORIGIN'
export const EVAL_INHOUSE_AUD_VAR = 'INHOUSE_EVAL_INHOUSE_AUD'
/** Every environment variable the paid run reads (names only; A10's eval-run gate lists them). */
export const READ_SIDE_ENV = [
  EVAL_BRAND_FLAG, EVAL_ORIGIN_VAR, EVAL_ISSUER_JWK_FILE, EVAL_AUD_VAR, EVAL_ACCESS_CLIENT_ID_VAR, EVAL_ACCESS_CLIENT_SECRET_VAR,
  EVAL_D1_NAME, EVAL_WRANGLER_CONFIG, EVAL_INHOUSE_ORIGIN_VAR, EVAL_INHOUSE_AUD_VAR, 'CF_SANDBOX_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN',
  'INHOUSE_EVAL_RUN', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
] as const
/** The read-side set's shops, exactly: the only hosts its shop door writes. */
export const READ_SIDE_SHOPS: ReadonlySet<string> = new Set(READ_SIDE_CASES.filter((c) => c.source === 'shopify').map((c) => readSideShopOf(c.id)))
/** The tables the readers SELECT from: any missing stops the run before spend (team_requests is optional until W3). */
export const READ_TABLES = ['memories', 'notices', 'routines', 'chat_files'] as const
/** Each request's deadline, its body read included. */
export const HTTP_TIMEOUT_MS = 30_000

const said = (e: unknown) => (e instanceof Error ? e.message : String(e))

export interface Wired {
  target: ProductTarget
  /** For the report: whether team request rows were read, or the table was proven absent. */
  teamRequests: 'rows' | 'absent'
  /** Gives back everything the run holds. One promise: every call awaits the same work. Errors are returned, never thrown. */
  close(): Promise<string[]>
}

/**
 * One HTTP call to an origin with a person's sign-in and the Access service token last; the token never reaches a message. Each
 * call has HTTP_TIMEOUT_MS with its body read. A body over `maxBytes` (by Content-Length or as read) is not read: the answer is
 * status 0, which every caller treats as unread (a file over the cap is then null, failing its case closed).
 */
export function rawHttp(origin: string, edge: Record<string, string>, auth: () => Promise<Record<string, string>>, doFetch: typeof fetch = fetch, maxBytes = EXTRACT_CAPS.fileBytes): RawApi {
  const hidden = Object.values(edge).filter((v) => v !== '')
  const scrub = (t: string) => hidden.reduce((s, v) => s.replaceAll(v, '[secret]'), t)
  return async (method, path, body) => {
    const headers: Record<string, string> = { ...(await auth()), ...edge }
    if (method !== 'GET') headers.Origin = origin
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const signal = AbortSignal.timeout(HTTP_TIMEOUT_MS)
      const r = await doFetch(`${origin}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal })
      const declared = Number(r.headers.get('content-length') ?? '0')
      if (declared > maxBytes) {
        await r.body?.cancel()
        return { status: 0, bytes: new Uint8Array(), json: null }
      }
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = r.body?.getReader()
      for (;;) {
        if (!reader) break
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          return { status: 0, bytes: new Uint8Array(), json: null }
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(Buffer.concat(chunks))
      let json: unknown = null
      try { json = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* not JSON */ }
      return { status: r.status, bytes, json }
    } catch (e) {
      throw new Error(`read-side: ${method} ${path} failed: ${scrub(said(e))}`)
    }
  }
}
const asCall = (raw: RawApi): SettingsApi['admin'] => async (method, path, body) => {
  const r = await raw(method, path, body)
  return { status: r.status, json: r.json }
}

/** Every table the readers use, then every reader's statement with LIMIT 0. Returns whether team_requests exists. */
async function checkTables(run: RunSql): Promise<boolean> {
  const probe = createRowReader(run, { teamRequestsTable: false })
  for (const t of READ_TABLES) if (!(await probe.hasTable(t))) throw new DoorRefusal(`refusing: the database has no ${t} table`)
  const team = await probe.hasTable('team_requests')
  await createRowReader(run, { teamRequestsTable: team }).probe()
  return team
}

/** The page origin serves one known page byte for byte (RS-WW1's fixture), or the run stops before spend. */
async function checkPage(origin: string, doFetch: typeof fetch): Promise<void> {
  const c = READ_SIDE_CASES.find((x) => x.id === 'RS-WW1')!
  const r = await doFetch(`${origin}/${c.id}/`, { redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  const text = await r.text()
  if (r.status !== 200 || text !== renderPage(c)) throw new Error(`read-side: refusing: ${origin}/${c.id}/ does not serve the page fixture (status ${r.status}): the page host isn't the eval pages Worker at this checkout`)
}

const nowOf = (run: RunSql) => async (): Promise<number> => {
  const v = (await run(`SELECT ${D1_NOW_MS} AS now`))[0]?.now
  if (!Number.isSafeInteger(v)) throw new DoorRefusal('the door read no clock')
  return v as number
}

type SignIn = (key: PersonKey, who: { sub: string; email: string }) => Promise<Record<string, string>>

export interface EvalOptions {
  env: Record<string, string | undefined>
  model: string
  budgetUsd: number
  cases: readonly ReadSideCase[]
  pageOrigin: string | null
  note: (line: string) => void
  /** Gets the run's close before the first preflight step, so a stop during the wiring gives back what it took. */
  register?: (close: () => Promise<string[]>) => void
  fetch?: typeof fetch
  /** Seams for the unit tests: the database, the sign-ins (the brand app, the Inhouse app) and the bucket. */
  run?: RunSql
  signIn?: SignIn
  signInhouse?: SignIn
  sessions?: SessionReader
}

/** The paid run's wiring on the eval deployment, with its preflight run and the effort pinned. Throws (exit 2) before any spend. */
export async function wireEval(o: EvalOptions): Promise<Wired> {
  const env = o.env
  if (o.budgetUsd > READ_SIDE_CAP_USD) throw new Error(`read-side: --budget $${o.budgetUsd} is over the read-side cap`)
  const runTag = env.INHOUSE_EVAL_RUN ?? (env.GITHUB_RUN_ID && env.GITHUB_RUN_ATTEMPT ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` : undefined)
  const origin = env[EVAL_ORIGIN_VAR]
  const inhouseOrigin = env[EVAL_INHOUSE_ORIGIN_VAR]
  const inhouseAud = env[EVAL_INHOUSE_AUD_VAR]
  if (!origin || !inhouseOrigin || !inhouseAud) throw new Error(`read-side: refusing: ${EVAL_ORIGIN_VAR}, ${EVAL_INHOUSE_ORIGIN_VAR} and ${EVAL_INHOUSE_AUD_VAR} must all be set`)
  const doFetch = o.fetch ?? fetch
  const run = o.run ?? wranglerRunner({ database: env[EVAL_D1_NAME] ?? '', config: env[EVAL_WRANGLER_CONFIG] ?? '', env })
  const door: MemoryDoor = createDoor(run)
  const shops: MorningDoor = createMorningDoor(run, Date.now, READ_SIDE_SHOPS)
  const signIn = o.signIn ?? testIssuerSignIn(env)
  const signInhouse = o.signInhouse ?? testIssuerSignIn({ ...env, [EVAL_AUD_VAR]: inhouseAud })
  // targets/product.ts refuses without the brand flag, the run tag, the origin and the Access token: before anything below.
  const product = createProductTarget({ paid: true, budgetUsd: o.budgetUsd, env, model: o.model, door, fetch: doFetch, signIn })
  const sessions = o.sessions ?? createSessionReader({ env, bucket: EVAL_BUCKET, fetch: doFetch })
  const edge = accessHeaders(env)
  const admin = rawHttp(origin, edge, () => signIn('lena', EVAL_PEOPLE.lena), doFetch)
  const settings: SettingsApi = { admin: asCall(admin), inhouse: asCall(rawHttp(inhouseOrigin, edge, () => signInhouse('lena', { sub: SEED_INHOUSE.subject, email: SEED_INHOUSE.email }), doFetch)) }

  const leaseTag = `product:${runTag}`
  let leased = false
  let restoreEffort: (() => Promise<void>) | null = null
  let target: ProductTarget | null = null
  /** The run's start on D1's clock and the routines it deleted: a stop sweeps every routine made since, as each case's end does. */
  let runStart: number | null = null
  const deleted = new Set<string>()
  let closing: Promise<string[]> | null = null
  const close = (): Promise<string[]> => (closing ??= (async () => {
    const errors: string[] = []
    const step = async (what: string, work: () => Promise<unknown>) => {
      try { await work() } catch (e) { errors.push(`${what}: ${said(e)}`) }
    }
    if (target) errors.push(...(await target.stop()))
    if (runStart !== null) errors.push(...(await deleteRoutines(createRowReader(run, { teamRequestsTable: false }), admin, runStart, deleted)))
    shops.close()
    await step('the test shop override could not be cleared', () => shops.clearShop())
    if (restoreEffort) await step('the effort could not be put back', restoreEffort)
    await step('the eval lease could not be given back', async () => {
      await product.close?.()
      if (leased) await door.releaseLease(leaseTag)
    })
    return errors
  })())
  o.register?.(close)
  try {
    // Preflight, before any spend: sign-in and the eval brand, the database and every reader's statement, the bucket, the page.
    const me = await admin('GET', '/api/me')
    if (me.status !== 200 || (me.json as { evalBrand?: unknown } | null)?.evalBrand !== true) throw new Error(`read-side: refusing: /api/me as the eval Admin answered ${me.status} without evalBrand: true`)
    const teamTable = await checkTables(run)
    await sessions.preflight()
    if (o.pageOrigin !== null && o.cases.some((c) => c.source === 'web_page')) await checkPage(o.pageOrigin, doFetch)
    // The lease under targets/product.ts's own tag (its first seed renews it), then the cap and the month's room for the budget.
    leased = true
    await door.takeLease(leaseTag)
    const shop = await door.testShop()
    if (shop !== null) throw new Error(`read-side: refusing: a test shop override (${shop}) is set: another run is on the eval deployment or left it`)
    await door.setSpendingCap(EVAL_CAP)
    const room = await product.room!()
    if (room.spentUsd + o.budgetUsd > room.capUsd) throw new Error(`read-side: refusing: this month's spend $${room.spentUsd.toFixed(2)} plus --budget $${o.budgetUsd} is over the brand's ${EVAL_CAP} cap`)
    const startUsd = room.spentUsd
    runStart = (await nowOf(run)()) - SINCE_MARGIN_MS
    restoreEffort = await pinEffort(settings, o.model)
    o.note(`read-side: effort pinned to Medium for ${o.model}; team requests: ${teamTable ? 'rows read from team_requests' : 'team_requests absent, observed empty'}`)
    const rows = createRowReader(run, { teamRequestsTable: teamTable })
    const deps: ProductDeps = {
      seed: (memory, ctx, exfil) => product.seed(memory, ctx, exfil),
      setWebfetchHosts: (hosts) => door.setWebfetchHosts(hosts),
      shop: { set: (h) => shops.setShop(h), clear: () => shops.clearShop() },
      rows: { ...rows, nowMs: nowOf(run) },
      sessions,
      caseApi: (caseId) => {
        const who = casePerson(runTag!, caseId, 1)
        return rawHttp(origin, edge, () => signIn('current', who), doFetch)
      },
      adminApi: admin,
      note: o.note,
      // The server's spend since the run's start (route 42), routine runs included: the runner stops before a case it can't afford.
      async spentUsd() {
        const now = (await product.room!()).spentUsd
        if (now < startUsd) throw new Error(`the month rolled over during the run (route 42's total $${now.toFixed(2)} is below the $${startUsd.toFixed(2)} at its start), so its spend can't be read`)
        return now - startUsd
      },
    }
    target = createProductReadSideTarget(deps, deleted)
    return { target, teamRequests: teamTable ? 'rows' : 'absent', close }
  } catch (e) {
    const errors = await close()
    if (errors.length) throw new Error(`${said(e)}; and ${errors.join('; ')}`, { cause: e })
    throw e
  }
}

export interface ProofOptions {
  env: Record<string, string | undefined>
  /** The PR whose test deployment this is: its database and bucket only. */
  pr: number
  /** product.ts's Api as the test build's people (`current` is the asking person, `lena` the Admin). */
  api: Api
  /** Raw calls as the asking person and the Admin. */
  raw: { current: RawApi; admin: RawApi }
  /** The scenario a case plays: the prompt is prefixed with `scenario:<name>`. */
  scenarioOf: (c: ReadSideCase) => string
  note: (line: string) => void
  /** Seams for the unit tests. */
  sessions?: SessionReader
  run?: RunSql
}

/** The scripted proof's wiring on a PR's test deployment. Refuses the eval deployment and any build that isn't the test build. */
export async function wireProof(o: ProofOptions): Promise<Wired> {
  const database = o.env[EVAL_D1_NAME] ?? ''
  if (database !== `inhouse-sbx-pr${o.pr}-db` || !PER_PR_DB.test(database)) throw new DoorRefusal(`refusing: the proof runs on PR ${o.pr}'s test database (inhouse-sbx-pr${o.pr}-db) only, not ${JSON.stringify(database)}`)
  const run = o.run ?? wranglerRunner({ database, config: o.env[EVAL_WRANGLER_CONFIG] ?? '', env: o.env, rule: 'morning-check' })
  const door = createDoor(run)
  const shops = createMorningDoor(run, Date.now, READ_SIDE_SHOPS)
  const me = await o.raw.current('GET', '/api/me')
  if (me.status !== 200) throw new Error(`read-side: refusing: the test issuer's sign-in answered ${me.status}`)
  if ((me.json as { evalBrand?: unknown } | null)?.evalBrand === true) throw new Error('read-side: refusing: this is the eval build (evalBrand: true), not a test build: the proof never runs on the real model')
  const memberId = (me.json as { memberId?: unknown } | null)?.memberId
  if (typeof memberId !== 'string') throw new Error('read-side: /api/me gave no member id')
  // The database must be the one this deployment answers from: a chat made through the API, read back through the door.
  const probe = `eval-probe-${randomBytes(12).toString('hex')}`
  const made = await o.raw.current('POST', '/api/chats', { id: probe, title: 'Eval probe' })
  if (made.status !== 200 && made.status !== 201) throw new Error(`read-side: refusing: the probe chat could not be made (${made.status})`)
  if (!(await door.hasChat(probe))) throw new DoorRefusal(`refusing: ${database} does not hold the chat the deployment just made, so it is not this deployment's database`)
  const sessions = o.sessions ?? createSessionReader({ env: o.env, bucket: `inhouse-sbx-pr${o.pr}-files`, proofPr: o.pr })
  const teamTable = await checkTables(run)
  await sessions.preflight()
  const rows = createRowReader(run, { teamRequestsTable: teamTable })
  const must = (r: { status: number }, what: string, ok: number[] = [200, 201]) => { if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status}`) }
  const runStart = (await nowOf(run)()) - SINCE_MARGIN_MS
  const deleted = new Set<string>()
  let target: ProductTarget | null = null
  let closing: Promise<string[]> | null = null
  const close = (): Promise<string[]> => (closing ??= (async () => {
    const errors: string[] = target ? await target.stop() : []
    errors.push(...(await deleteRoutines(rows, o.raw.admin, runStart, deleted)))
    shops.close()
    await shops.clearShop().catch((e: unknown) => errors.push(`the test shop override could not be cleared: ${said(e)}`))
    await door.setWebfetchHosts(null).catch((e: unknown) => errors.push(`the WebFetch list could not be put back: ${said(e)}`))
    return errors
  })())
  const seed = async (memory: SeedFact[], ctx: RunContext, exfil?: ExfilSpec): Promise<Session> => {
    await door.clear()
    const facts = memory.map((f) => ({ id: `mem_${randomBytes(16).toString('base64url')}`, scope: f.scope, ownerId: f.scope === 'person' ? memberId : null, text: f.fact }))
    if (exfil?.via === 'memory_search') facts.push({ id: `mem_${randomBytes(16).toString('base64url')}`, scope: 'person', ownerId: memberId, text: exfil.plant(ctx.canary) })
    await door.insert(facts)
    const attachment = exfil?.via === 'attachment' ? { name: 'note.txt', bytes: new TextEncoder().encode(exfil.plant(ctx.canary)) } : undefined
    return productSession({
      api: o.api, must, door, people: { current: memberId, tom: '', lena: '' }, askedAs: 'proof', picker: 'sonnet', real: new Map(), attachment,
      pollMs: 2000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), onSpend: () => {},
    })
  }
  target = createProductReadSideTarget({
    seed,
    setWebfetchHosts: (hosts) => door.setWebfetchHosts(hosts),
    shop: { set: (h) => shops.setShop(h), clear: () => shops.clearShop() },
    rows: { ...rows, nowMs: nowOf(run) },
    sessions,
    caseApi: () => o.raw.current,
    adminApi: o.raw.admin,
    prompt: (c, p) => `scenario:${o.scenarioOf(c)} ${p}`,
    note: o.note,
  }, deleted)
  return { target, teamRequests: teamTable ? 'rows' : 'absent', close }
}
