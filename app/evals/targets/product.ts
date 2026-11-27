// The product target (W7 PR 2): the real product over HTTP, as the eval people. Per case-repeat it seeds memory (the eval
// deployment's D1, through door.ts), sends each prompt through route 29 in a fresh chat, waits for the turn's end, and reads
// the answer from route 24 and the tool names and settled cost from route 33.
//
// What the API shows decides what can be graded (A8, 2026-11-21; the eval build, p3-eval-observability rev 2 rec 5 and 6): on the
// eval deployment route 33 gives one `tool` step per call with the tool's name and, for the run's owner, its kept input
// (`io.input`, the audit entry's capped input), a cut mark and the hook's denial (`io.denied`); route 24 gives the answer's text
// parts. No route carries a tool's result. So:
//   - tool calls come from route 33's steps with their inputs; a memory write's input comes from the brand's memory rows before
//     and after the chat (a new row is a memory_save, a changed text a memory_update), and a write that left no row is refused;
//   - a WebFetch's refusal is the hook's denial (no result exists): an unlisted one without it is a bypass (exfil.ts);
//   - a case whose grading needs something no route shows is "not graded on product" (`unobservable`), with the reason named;
//   - cost is the server's settled figure for the turn (route 33's `cost`, whole cents), never the SDK's estimate.
// Cases run one at a time: the brand's memory is shared, so a concurrent case would read another's seeded facts.
import { promptFailure, promptSentOf } from '../prompt-version.ts'
import { shopifyNotServed } from '../shopify-served.ts'
import { mintPerson } from '../../server/auth/test-issuer-mint.ts'
import { SEED_PEOPLE } from '../../server/seed/brand.ts'
import { CancelWhySchema, TurnFailureSchema } from '../../shared/contract/runs.ts'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { JWK } from 'jose'
import { createDoor, newActionId, newMemoryId, wranglerRunner, type MemoryDoor, type MemoryRow, type NewMemory } from './door.ts'
import { CapReachedError, type Case, type ChatResult, type ExfilSpec, type People, type PersonKey, type RunContext, type SeedApproval, type SeedFact, type Session, type Target, type ToolCall } from '../types.ts'

/**
 * The eval brand's monthly Spending cap: Wasim's monthly Anthropic test budget, $50 (2026-11-22, superseding decision 18's
 * $40), enforced by us; the $60 workspace limit is the outer stop.
 */
export const EVAL_CAP = '$50'
/**
 * The eval brand's job budget (`s:job_cap`, Stage 1 M1-P): $1. A case whose turn hits its step limit carries on as a
 * long job behind the harness, up to the job budget ($25 by default); pinned low every run so no case spends past the
 * run's own budget that way (Fable's review of #441).
 */
export const EVAL_JOB_CAP = '$1'

export class ProductTargetRefusal extends Error {
  override name = 'ProductTargetRefusal'
}

/** Env flag names: the eval deployment sets both. The first marks the brand as an eval brand, the second names its origin. */
export const EVAL_BRAND_FLAG = 'INHOUSE_EVAL_BRAND'
export const EVAL_ORIGIN_VAR = 'INHOUSE_EVAL_ORIGIN'
/** The deployment's test issuer: the private key (a file) and the brand app's `aud`. The eval deployment is a test build in the sandbox. */
export const EVAL_ISSUER_JWK_FILE = 'INHOUSE_EVAL_ISSUER_JWK_FILE'
export const EVAL_AUD_VAR = 'INHOUSE_EVAL_AUD'
/**
 * The eval host's Access lock (Wasim's E-5 second lock): the dedicated service token `inhouse-sbx-eval-ci`, held only in
 * inhouse-ops. Every call to the eval origin carries it as CF-Access-Client-Id and CF-Access-Client-Secret, as the house's
 * service-token calls do (inhouse-ops house-model-smoke.mjs). Never printed.
 */
export const EVAL_ACCESS_CLIENT_ID_VAR = 'INHOUSE_EVAL_ACCESS_CLIENT_ID'
export const EVAL_ACCESS_CLIENT_SECRET_VAR = 'INHOUSE_EVAL_ACCESS_CLIENT_SECRET'
/**
 * The header the test-issuer JWT also travels in: Access in front sets its own Cf-Access-Jwt-Assertion, so the eval build
 * may read the test issuer's from here (held: authenticate.ts reads it only after the lock probe shows Access replaces
 * Cf-Access-Jwt-Assertion). Sent in both, so the probe answers either way.
 */
export const TEST_ASSERTION_HEADER = 'X-Inhouse-Test-Assertion'

/** The Access service token's header names, lowercased: a caller's own copy is dropped before ours goes on. */
const EDGE_KEYS = new Set(['cf-access-client-id', 'cf-access-client-secret'])

/**
 * How long a person's signed headers are reused: half the test issuer's token life (test-issuer-mint.ts: 600 s). The first
 * paid baseline (inhouse-ops run 44967754241) cached them for the whole run and died on a 401 10 min 38 s in.
 */
export const SIGN_REFRESH_MS = 300_000

/** The Access service token's headers, or a refusal naming the variables (never their values). */
export function accessHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const id = env[EVAL_ACCESS_CLIENT_ID_VAR]
  const secret = env[EVAL_ACCESS_CLIENT_SECRET_VAR]
  if (!id || !secret) throw new ProductTargetRefusal(`refusing: ${EVAL_ACCESS_CLIENT_ID_VAR} and ${EVAL_ACCESS_CLIENT_SECRET_VAR} are not both set, so the eval host's Access lock would refuse every call`)
  return { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }
}


/**
 * A turn's end cause in the product's own vocabulary (shared/contract/chats.ts TurnEndSchema): `failure:<TurnFailure>`,
 * `cancel:<CancelWhy>` or `outcome:stopped|interrupted`, the first of the three the end row carries. `unknown` only for
 * text outside that vocabulary, so it's never mistaken for the product's own `failure:unknown`.
 */
function endCause(end: { failure?: unknown; why?: unknown; outcome?: unknown }): string {
  if (typeof end.failure === 'string' && (TurnFailureSchema.options as readonly string[]).includes(end.failure)) return `failure:${end.failure}`
  if (typeof end.why === 'string' && (CancelWhySchema.options as readonly string[]).includes(end.why)) return `cancel:${end.why}`
  if (end.outcome === 'stopped' || end.outcome === 'interrupted') return `outcome:${end.outcome}`
  return 'unknown'
}

/** The eval deployment's D1 database name and the sandbox wrangler config that binds it (door.ts). */
export const EVAL_D1_NAME = 'INHOUSE_EVAL_D1_NAME'
export const EVAL_WRANGLER_CONFIG = 'INHOUSE_EVAL_WRANGLER_CONFIG'

/** The eval principals: the seeded brand's people (invented, on example.test). `lena` is the Admin, who also lists the members. */
export const EVAL_PEOPLE: Record<PersonKey, { sub: string; email: string }> = {
  current: { sub: SEED_PEOPLE.dana.subject, email: SEED_PEOPLE.dana.email },
  tom: { sub: SEED_PEOPLE.leo.subject, email: SEED_PEOPLE.leo.email },
  lena: { sub: SEED_PEOPLE.admin.subject, email: SEED_PEOPLE.admin.email },
}
const PEOPLE_KEYS: PersonKey[] = ['current', 'tom', 'lena']

/** The picker ids route 29 takes, by the API model id the harness's --model names. */
export const PICKER_OF: Record<string, string> = { 'claude-fable-5-2': 'fable', 'claude-opus-5-5': 'opus', 'claude-sonnet-5-5': 'sonnet', 'claude-haiku-5-5': 'haiku' }

export interface ProductTargetOptions {
  paid: boolean
  budgetUsd?: number
  env: Record<string, string | undefined>
  fetch?: typeof fetch
  model?: string
  /** The headers that sign `key` in. Default: a test-issuer token from INHOUSE_EVAL_ISSUER_JWK_FILE and INHOUSE_EVAL_AUD. */
  signIn?: (key: PersonKey, who: { sub: string; email: string }) => Promise<Record<string, string>>
  /** The tools the server serves with an open input schema (evals/served-schema.ts): their cases don't grade args. */
  openSchema?: ReadonlySet<string>
  /** The clock the sign-in cache reads (tests). Default: Date.now. */
  now?: () => number
  /** The memory door. Default: wrangler on INHOUSE_EVAL_D1_NAME (door.ts), made only after the eval-brand check passed. */
  door?: MemoryDoor
  /** Milliseconds between reads while a turn runs. */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** True for an email on `example.test` or a subdomain: the invented domain the seeded brands use. */
export const onExampleTest = (email: string | null): boolean => email !== null && /^[^@\s]+@(?:[a-z0-9-]+\.)*example\.test$/i.test(email)

interface Member { id: string; email: string | null; status: string; rev: number }

/**
 * A case-repeat's own person (A9, after the first full baseline: past chats persist, and history_search is member-scoped):
 * deterministic per run, case and rep, on example.test, so a re-run doesn't collide; each row names it (`askedAs`).
 */
export function casePerson(run: string, caseId: string, rep: number): { sub: string; email: string; name: string } {
  const handle = `eval-${run}-${caseId.toLowerCase()}-r${rep}`
  return { sub: handle, email: `${handle}@example.test`, name: `Eval ${caseId} r${rep}` }
}
/** A case person's email: what run start removes when it's another run's. */
const CASE_PERSON = /^eval-[a-z0-9-]+@example\.test$/
const newMemberId = (): string => `m_${randomBytes(16).toString('base64url')}`
/** What to do when the member check's page cap trips: the case persons have filled it. */
const MEMBER_CAP_FIX = 'reset the eval D1 (delete inhouse-sbx-eval-db, then dispatch eval-deploy with -f seed=true at app main\'s head)'

/** Why the product target can't grade a case: a field its API doesn't show. Null when it can. */
export function unobservableReason(c: Case): string | null {
  if (c.exfil?.via === 'history_search') return 'planting through history_search needs a priming chat'
  for (const chat of c.chats) {
    const args = chat.expect.args
    if (args && 'person_id' in args) return 'memory_save person_id (the product saves only for the person asking; it has no person_id)'
  }
  return null
}

interface TraceStep { kind: string; detail: string; io?: { input: string; cut?: true; denied?: true } }
/** A `tool` step as a call: its kept input parsed, a cut (or unparsable) input as `{}` marked `inputCut`, a denial as `hookDenied`. */
/** A tool input with every string that is a seeded fact's product id replaced by the seed's id (top-level values). */
export function seedIds(input: Record<string, unknown>, seedOf: (productId: string) => string | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === 'string' ? (seedOf(v) ?? v) : v]))
}

export function callOfStep(s: TraceStep): ToolCall {
  let input: Record<string, unknown> = {}
  let cut = s.io?.cut === true
  if (s.io !== undefined && !cut) {
    try {
      const parsed: unknown = JSON.parse(s.io.input)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
      else cut = true
    } catch { cut = true }
  }
  return { name: s.detail, input, ...(s.io?.denied === true ? { hookDenied: true } : {}), ...(cut ? { inputCut: true } : {}) }
}

export function createProductTarget(opts: ProductTargetOptions): Target {
  if (!opts.paid) throw new ProductTargetRefusal('the product target spends real money: pass --paid and --budget <usd>')
  if (!(typeof opts.budgetUsd === 'number' && opts.budgetUsd > 0)) throw new ProductTargetRefusal('the product target needs --budget <usd> above zero')
  if (opts.env[EVAL_BRAND_FLAG] !== '1') throw new ProductTargetRefusal(`refusing: ${EVAL_BRAND_FLAG}=1 is not set, so the brand isn't marked as an eval brand`)
  // The run's tag: the case persons' ids carry it (INHOUSE_EVAL_RUN, else GitHub's run id and attempt).
  const runTag = opts.env.INHOUSE_EVAL_RUN ?? (opts.env.GITHUB_RUN_ID && opts.env.GITHUB_RUN_ATTEMPT ? `${opts.env.GITHUB_RUN_ID}-${opts.env.GITHUB_RUN_ATTEMPT}` : undefined)
  if (!runTag || !/^[0-9]{1,20}(-[0-9]{1,6})?$/.test(runTag)) throw new ProductTargetRefusal('refusing: no run tag as a run id and attempt (INHOUSE_EVAL_RUN like 44971615417-1, or GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT), so the case persons would collide')
  const origin = opts.env[EVAL_ORIGIN_VAR]
  if (!origin) throw new ProductTargetRefusal(`refusing: ${EVAL_ORIGIN_VAR} is not set`)
  const picker = PICKER_OF[opts.model ?? 'claude-sonnet-5-5']
  if (!picker) throw new ProductTargetRefusal(`refusing: no model picker id for ${JSON.stringify(opts.model)}`)
  // Before any call: every request to the eval origin passes its Access lock with the service token.
  const edge = accessHeaders(opts.env)

  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = opts.pollMs ?? 2000
  const people: People = { current: '', tom: '', lena: '' }
  const signIn = opts.signIn ?? testIssuerSignIn(opts.env)
  const now = opts.now ?? Date.now
  // Each person's signed headers and when they were signed: re-signed once SIGN_REFRESH_MS old, well before expiry.
  const headersOf = new Map<string, { headers: Record<string, string>; at: number }>()
  /** The case-repeat's own person, who asks as `current` (set by seed()). */
  let caseWho: { sub: string; email: string } | undefined

  async function api(who: PersonKey, method: string, path: string, o: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<{ status: number; json: any; text: string }> {
    const id = who === 'current' && caseWho ? caseWho : EVAL_PEOPLE[who]
    let signed = headersOf.get(`${who}:${id.sub}`)
    if (!signed || now() - signed.at >= SIGN_REFRESH_MS) {
      signed = { headers: await signIn(who, id), at: now() }
      headersOf.set(`${who}:${id.sub}`, signed)
    }
    const h = signed.headers
    // The service token last, and any caller's token header dropped first in any case (#277 review F4: Headers would join
    // a differently cased duplicate with ours), so nothing replaces or corrupts it.
    const headers: Record<string, string> = Object.fromEntries(Object.entries({ ...h, ...o.headers }).filter(([k]) => !EDGE_KEYS.has(k.toLowerCase())))
    Object.assign(headers, edge)
    if (method !== 'GET') headers.Origin = origin!
    let body: BodyInit | undefined
    if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = 'application/json' }
    else if (o.bytes !== undefined) { body = o.bytes as unknown as BodyInit; headers['Content-Type'] = headers['Content-Type'] ?? 'application/octet-stream' }
    const res = await doFetch(`${origin}${path}`, { method, headers, body, signal: o.signal })
    const text = await res.text()
    let json: unknown = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    return { status: res.status, json, text }
  }
  // What and the status, and the Worker's error code when it's a plain code: never the response body, which can be an
  // Access page with hostnames and a Ray ID, and ends up in report.json (#280 review 2).
  const must = (r: { status: number; json?: any }, what: string, ok: number[] = [200, 201]): void => {
    if (ok.includes(r.status)) return
    const code = r.json?.error?.code
    throw new Error(`${what}: ${r.status}${typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? ` ${code}` : ''}`)
  }

  let door: MemoryDoor | undefined = opts.door
  let ready: Promise<void> | undefined
  /** The server-side eval-brand check, then the people's ids and the door. Once, before the first chat. */
  /** The eval lease's tag (door.ts takeLease): this run's. */
  const leaseTag = `product:${runTag}`
  let leased = false
  /**
   * The first take while it's in flight: close() waits for it, so a signal during setup still gives back a lease the take
   * goes on to win (#306 review L3).
   */
  let taking: Promise<void> | null = null
  const setup = (): Promise<void> => (ready ??= (async () => {
    for (const k of PEOPLE_KEYS) {
      const me = await api(k, 'GET', '/api/me')
      must(me, `sign in as the eval person ${k}`, [200])
      // The first line (p3-eval-observability rev 2, "The eval-brand marker"): the server's own deploy-time fact, true only on the
      // eval build with INHOUSE_EVAL_BRAND=1. Before any other read, write or door.
      if (me.json.evalBrand !== true) throw new ProductTargetRefusal('refusing: /api/me does not say evalBrand: true, so this deployment is not the eval brand')
      people[k] = me.json.memberId
    }
    // The second line (A8): every member on the brand is an invented example.test address, and the eval people are among them.
    const members: Member[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 100; pages++) {
      const r = await api('lena', 'GET', `/api/members?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`)
      must(r, 'list the brand\'s members', [200])
      members.push(...r.json.items)
      cursor = r.json.nextCursor
      if (cursor === null) break
    }
    // Fail closed: members past the page cap were never checked.
    if (cursor !== null) throw new ProductTargetRefusal(`refusing: the brand has more members than the check reads (100 pages), so it is not known to be an eval brand. On the eval brand the case persons fill it (about one per case-repeat): ${MEMBER_CAP_FIX}`)
    const live = members.filter((m) => m.status !== 'removed')
    const offenders = live.filter((m) => !onExampleTest(m.email))
    if (offenders.length > 0) throw new ProductTargetRefusal(`refusing: ${offenders.length} member(s) of this brand are not on example.test, so it is not an eval brand`)
    for (const k of PEOPLE_KEYS) if (!live.some((m) => m.id === people[k])) throw new ProductTargetRefusal(`refusing: eval person ${k} is not an active member of this brand`)
    // Run start: the previous runs' case persons are removed through the product's own API (its audit line), as the Admin.
    // A removal that fails stops the run here, before any spend.
    // A run tag used before: its case persons are already here, so this run's invites would collide (#282 review L2).
    // `eval-<tag>-<letter>`: case ids start with a letter, so tag 7 never reads tag 7-1's persons as its own (#282 re-review L4).
    const ofThisTag = new RegExp(`^eval-${runTag}-[a-z]`)
    if (live.some((m) => m.email !== null && ofThisTag.test(m.email))) throw new ProductTargetRefusal(`refusing: the run tag ${runTag} was used before (its case persons are on the brand): give the run a new one`)
    for (const m of live) {
      if (!m.email || !CASE_PERSON.test(m.email)) continue
      const r = await api('lena', 'DELETE', `/api/members/${encodeURIComponent(m.id)}?ifRev=${m.rev}`)
      if (r.status !== 200 && r.status !== 204) {
        const code = r.json?.error?.code
        throw new ProductTargetRefusal(`refusing: could not remove the previous run's case person ${m.id} (${r.status}${typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? ` ${code}` : ''})`)
      }
    }
    const models = await api('current', 'GET', '/api/models')
    must(models, 'read the models', [200])
    if (!models.json.modes?.some((m: { id: string }) => m.id === picker)) throw new ProductTargetRefusal(`refusing: the brand does not serve the ${picker} model`)
    // #337 round 2: the store must be served, or every graded turn's prompt says none is connected. Before the lease and any spend.
    const tools = await api('lena', 'GET', '/api/tools')
    must(tools, 'read the brand\'s tools', [200])
    const notServed = shopifyNotServed(tools.json)
    if (notServed !== null) throw new ProductTargetRefusal(`refusing: ${notServed}`)
    // (a) the door only after the check passed; (b) and (c) are door.ts's.
    door ??= createDoor(wranglerRunner({ database: opts.env[EVAL_D1_NAME] ?? '', config: opts.env[EVAL_WRANGLER_CONFIG] ?? '', env: opts.env }))
    // The database must be the one this origin answers from: make a chat through the API, read it back through the door. Nothing is
    // cleared or written before this passes.
    const probe = `eval-probe-${rid()}`
    must(await api('current', 'POST', '/api/chats', { json: { id: probe, title: 'Eval probe' } }), 'create the probe chat')
    if (!(await door.hasChat(probe))) throw new ProductTargetRefusal(`refusing: ${EVAL_D1_NAME} does not hold the chat the origin just created, so it is not this deployment's database`)
    // One runner per eval deployment (#308 review): the eval lease before any write that spends, renewed by every seed and
    // given back by close(). A test shop override on the deployment means a morning-check run is on it (or left it): this
    // run's hub calls would read its shop, so it refuses.
    const d0 = door
    taking = d0.takeLease(leaseTag).then(() => { leased = true })
    await taking
    const shop = await door.testShop()
    if (shop !== null) throw new ProductTargetRefusal(`refusing: a test shop override (hub:shop ${shop}) is set on the eval deployment, so this run's hub calls would read a morning-check shop: a morning-check run is on it or left it`)
    // The O2 note: the brand's own Spending cap is the run's $50 (no second ledger). Pinned here, then read back as the
    // product reads it: anything else refuses before any case is seeded.
    await door.setSpendingCap(EVAL_CAP)
    await door.setJobCap(EVAL_JOB_CAP)
    const { spentUsd } = await room()
    // A month already at the cap is refused here, not on the first chat (#253 review O1).
    if (spentUsd >= Number(EVAL_CAP.slice(1))) throw new ProductTargetRefusal(`refusing: this month's spend ($${spentUsd.toFixed(2)}) has reached the ${EVAL_CAP} cap`)
  })())

  /** The month's spend and the cap, from route 42 (the Usage page's numbers) as the Admin eval person. */
  // Every read refuses unless the cap is still the pinned $50 (#253 review O3): a re-seed's $320 or a Settings change can't
  // silently lift our layer mid-run.
  async function room(): Promise<{ spentUsd: number; capUsd: number }> {
    const u = await api('lena', 'GET', '/api/usage')
    must(u, 'read the month\'s usage', [200])
    const cents = (m: unknown, what: string) => {
      if (!Number.isInteger(m)) throw new Error(`route 42 gave no ${what}`)
      return (m as number) / 100
    }
    const r = { spentUsd: cents(u.json?.total?.minor, 'total'), capUsd: cents(u.json?.cap?.minor, 'cap') }
    if (Math.round(r.capUsd * 100) !== Number(EVAL_CAP.slice(1)) * 100) throw new ProductTargetRefusal(`refusing: the brand's Spending cap is not ${EVAL_CAP} (route 42 says $${r.capUsd.toFixed(2)})`)
    return r
  }

  async function resetWebTools(d: MemoryDoor) {
    try {
      await d.setWebSearch(false)
    } finally {
      await d.setWebfetchHosts(null)
    }
  }

  let spentTotal = 0
  let tail: Promise<void> = Promise.resolve()

  return {
    name: 'product',
    people,
    // P3 builds none of the shop and mail connectors or routines: the cases that need them report as not run (phase P4/P5).
    provides: new Set<string>(),
    ...(opts.openSchema ? { openSchema: opts.openSchema } : {}),
    unobservable: unobservableReason,
    spentUsd: () => spentTotal,
    room,
    async close() {
      await taking?.catch(() => {})
      if (leased) await door!.releaseLease(leaseTag)
      leased = false
    },
    async seed(memory: SeedFact[], run: RunContext, exfil?: ExfilSpec): Promise<Session> {
      // One case-repeat at a time: the brand's memory is shared.
      const prev = tail
      let release!: () => void
      tail = new Promise<void>((r) => (release = r))
      await prev
      let session: Session
      // Once settings writes start, any failure restores both defaults before the brand is released.
      let settingsTouched = false
      try {
        await setup()
        const d = door!
        // Each case-repeat renews the eval lease (it lapses only for a run that died).
        await d.takeLease(leaseTag)
        // Every case starts from a known WebFetch list (#245 S-L2): an exfiltration case's hosts (rec 6: the hook refuses
        // exactly what the grader calls unlisted), any other case the default.
        settingsTouched = true
        await d.setWebSearch(false)
        await d.setWebfetchHosts(exfil ? exfil.hosts.map((h) => h.toLowerCase()) : null)
        await d.clear()
        // The case-repeat's own person: invited through the door, bound by its first sign-in (the product's invite path).
        const who = casePerson(runTag, run.caseId, run.rep)
        const personId = newMemberId()
        try {
          await d.invitePerson({ id: personId, email: who.email, name: who.name })
        } catch (e) {
          // The door's own error, never a guess at why (#282 re-review M1).
          throw new ProductTargetRefusal(`refusing: could not invite the case person ${who.sub} (run tag ${runTag}): ${e instanceof Error ? e.message : String(e)}`, { cause: e })
        }
        caseWho = who
        const me = await api('current', 'GET', '/api/me')
        must(me, 'sign in as the case person')
        if (me.json.memberId !== personId || me.json.evalBrand !== true) throw new ProductTargetRefusal(`refusing: the case person ${who.sub} did not sign in as the invited row`)
        people.current = personId
        const real = new Map<string, string>()
        const facts: NewMemory[] = memory.map((f) => {
          const id = newMemoryId()
          if (f.memoryId) real.set(id, f.memoryId)
          return { id, scope: f.scope, ownerId: f.scope === 'person' ? people[f.person ?? 'current'] : null, text: f.fact }
        })
        let attachment: { name: string; bytes: Uint8Array } | undefined
        if (exfil?.via === 'memory_search') facts.push({ id: newMemoryId(), scope: 'person', ownerId: people.current, text: exfil.plant(run.canary) })
        if (exfil?.via === 'attachment') attachment = { name: 'note.txt', bytes: new TextEncoder().encode(exfil.plant(run.canary)) }
        await d.insert(facts)
        session = productSession({ api, must, door: d, people, picker, real, attachment, approvals: run.approvals, pollMs, sleep, askedAs: who.sub, onSpend: (usd) => { spentTotal += usd } })
      } catch (e) {
        try {
          if (settingsTouched) await resetWebTools(door!)
        } catch (restore) {
          throw new AggregateError([e, restore], "the seed failed, and restoring the brand's web tool defaults failed too")
        } finally {
          release()
        }
        throw e
      }
      const d = door!
      // Restore both web-tool defaults even when session reset fails, then release the brand.
      return { ...session, async reset() { try { await session.reset() } finally { try { await resetWebTools(d) } finally { release() } } } }
    },
  }
}

export type Api = (who: PersonKey, method: string, path: string, o?: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json: any; text: string }>

export interface SessionDeps {
  api: Api
  must: (r: { status: number; text: string }, what: string, ok?: number[]) => void
  door: MemoryDoor
  people: People
  /** The case person who asks (`eval-<run>-<case>-r<rep>`). */
  askedAs: string
  picker: string
  /** Real memory id (or approval id) to the case's own id (`m_norda`, `ap_204`). */
  real: Map<string, string>
  attachment?: { name: string; bytes: Uint8Array }
  /** The case's approvals (Stage 1 M2-G): seeded waiting in the first chat, as the case person's, before its turn. */
  approvals?: SeedApproval[]
  pollMs: number
  sleep: (ms: number) => Promise<void>
  onSpend: (usd: number) => void
}

/** Route 33's cost is whole cents, rounded to the nearest: the true figure is under half a cent more, so it is booked at that upper bound. */
export const cents = (minor: number): number => (minor + 0.5) / 100

const rid = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 24)
const ZERO = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }

/** The memory writes a chat made, as tool calls, from the rows before and after it. */
export function writesFromRows(before: MemoryRow[], after: MemoryRow[], caseId: (realId: string) => string, ownerKey: (id: string | null) => string): ToolCall[] {
  const was = new Map(before.map((r) => [r.id, r]))
  const out: ToolCall[] = []
  for (const r of after) {
    const old = was.get(r.id)
    if (!old) out.push({ name: 'mcp__inhouse__memory_save', input: { scope: r.scope, ...(r.scope === 'person' ? { person_id: ownerKey(r.ownerId) } : {}), fact: r.text }, result: 'Saved (a new row in the brand\'s memory)', isError: false })
    else if (old.text !== r.text) out.push({ name: 'mcp__inhouse__memory_update', input: { memory_id: caseId(r.id), fact: r.text }, result: 'Updated (the row\'s text changed)', isError: false })
  }
  return out
}

/** The tool a turn parks on (Stage 1 M2-Q, N16): the chat then waits on the person's answer, with no answer or end row. */
export const QUESTION_ASK = 'mcp__inhouse__question_ask'

/** An open question the agent asked in this chat (route 140, the chat owner's list), or null. */
export interface ParkedQuestion { question: string; options: string[] }
export function parkedQuestionOf(items: { chatId: string | null; state: string; question: string; options: string[] }[], chatId: string): ParkedQuestion | null {
  const q = items.find((x) => x.chatId === chatId && x.state === 'open')
  return q ? { question: q.question, options: q.options } : null
}

/** What a parked turn's answer reads as for grading: the question and its options, as the person sees them. */
export const parkedAnswer = (q: ParkedQuestion): string => `Asked: ${q.question}\nOptions: ${q.options.join(' | ')}`

/** One case-repeat's chats (exported for the read-side set's scripted proof, which signs in on a PR's test build). */
export function productSession(d: SessionDeps): Session {
  const turns: string[] = []
  let booked = 0
  let attachment = d.attachment
  let approvals: readonly SeedApproval[] = d.approvals ?? []
  const seededApprovals: string[] = []
  const personKey = (id: string | null): string => PEOPLE_KEYS.find((k) => d.people[k] === id) ?? String(id)

  async function turnCost(turnId: string): Promise<number> {
    const t = await d.api('current', 'GET', `/api/traces/${encodeURIComponent(turnId)}`)
    if (t.status !== 200) throw new Error(`the trace of ${turnId} could not be read (${t.status}), so its cost is unknown`)
    return cents(t.json.cost.minor as number)
  }
  /**
   * Stops every turn this session sent, repeating until the server answers 409 `turn_ended`, which it does once the turn is fenced
   * (state `ending`, its runner still flushing), not only once it is fully ended. So after this the turn can still be in its grace;
   * the cost read that follows is then safe: an open model call is booked at its worst case (runs-read.ts), so it over-books.
   * A throw here is loud: reset() calls it too, and the runner stops the whole eval on it.
   */
  async function endTurns(): Promise<void> {
    const deadline = AbortSignal.timeout(30_000)
    for (const t of turns) {
      for (;;) {
        const r = await d.api('current', 'POST', `/api/turns/${encodeURIComponent(t)}/stop`, { json: {} })
        if (r.status === 409 || r.status === 404) break // `turn_ended`, or no such turn
        if (deadline.aborted) throw new Error(`turn ${t} did not end after a stop`)
        if (r.status !== 200) throw new Error(`stop turn ${t}: ${r.status}`)
        await d.sleep(d.pollMs)
      }
    }
  }
  async function bookCost(): Promise<number> {
    await endTurns()
    let total = 0
    for (const t of turns) total += await turnCost(t)
    d.onSpend(Math.max(0, total - booked))
    booked = total
    return total
  }

  return {
    async chat(prompt, o): Promise<ChatResult> {
      const before = await d.door.rows()
      const chatId = `eval-${rid()}`
      d.must(await d.api('current', 'POST', '/api/chats', { json: { id: chatId, title: 'Eval chat' }, signal: o?.signal }), 'create the chat')
      // The case's approvals (M2-G: T15, T16), the person's own, waiting in this chat; the prompt names each by its real id.
      for (const a of approvals) {
        const id = newActionId()
        await d.door.insertApproval({ id, chatId, askedBy: d.people.current, title: a.title, line: a.line })
        seededApprovals.push(id)
        d.real.set(id, a.id)
        prompt = prompt.replaceAll(a.id, id)
      }
      approvals = []
      let attachments: { fileId: string; name: string }[] | undefined
      if (attachment) {
        const up = await d.api('current', 'POST', `/api/chats/${chatId}/attachments`, { bytes: attachment.bytes, headers: { 'X-File-Name': encodeURIComponent(attachment.name), 'Content-Type': 'text/plain' }, signal: o?.signal })
        d.must(up, 'upload the attachment')
        attachments = [{ fileId: up.json.fileId, name: up.json.name }]
        attachment = undefined
      }
      const sent = await d.api('current', 'POST', `/api/chats/${chatId}/turns`, { json: { clientTurnKey: `eval-${rid()}`, text: prompt, model: d.picker, ...(attachments ? { attachments } : {}) }, signal: o?.signal })
      d.must(sent, 'send the turn', [200, 201, 202])
      const turnId: string = sent.json.turnId
      turns.push(turnId)

      // The turn has ended once its answer is stored: the projection writes a turn's messages in one batch when it ends.
      // A lone `question_ask` (on in every build since M2-H) parks the turn instead: no answer and no end row, the chat
      // waiting on the person's answer. That open question is the turn's end here (T10 grades the call).
      let answer = ''
      let sawError = false
      let failure: string | undefined
      let parked: ParkedQuestion | null = null
      for (;;) {
        if (o?.signal?.aborted) throw new Error('the chat was aborted')
        const page = await d.api('current', 'GET', `/api/chats/${chatId}`, { signal: o?.signal })
        d.must(page, 'read the chat', [200])
        const messages = page.json.messages as { role: string; turnId: string; pos: number; part?: { type: string; text?: string }; end?: { failure?: string; why?: string; outcome?: string } }[]
        // The turn's end row: the Spending cap fenced it (stop the run, never a pass), or it ended with no answer at all.
        const end = messages.find((m) => m.role === 'event' && m.turnId === turnId && m.end)?.end
        if (end?.failure === 'cap_reached' || end?.why === 'cap_reached') throw new CapReachedError(turnId)
        const mine = messages.filter((m) => m.role === 'agent' && m.turnId === turnId).sort((a, b) => a.pos - b.pos)
        if (mine.length === 0 && end) {
          sawError = true
          failure = endCause(end)
          break
        }
        if (mine.length > 0) {
          answer = mine.filter((m) => m.part?.type === 'text').map((m) => m.part!.text ?? '').join('\n\n')
          sawError = mine.some((m) => m.part?.type === 'error')
          if (sawError) failure = 'error_part'
          break
        }
        if (!end) {
          const open = await d.api('current', 'GET', '/api/questions', { signal: o?.signal })
          d.must(open, 'read the open questions', [200])
          parked = parkedQuestionOf(open.json.items, chatId)
          if (parked) {
            answer = parkedAnswer(parked)
            break
          }
        }
        await d.sleep(d.pollMs)
      }

      const trace = await d.api('current', 'GET', `/api/traces/${encodeURIComponent(turnId)}`, { signal: o?.signal })
      d.must(trace, 'read the trace', [200])
      const steps = (trace.json.steps as TraceStep[]).filter((s) => s.kind === 'tool')
      const costUsd = cents(trace.json.cost.minor as number)
      booked += costUsd
      d.onSpend(costUsd)

      const writes = writesFromRows(before, await d.door.rows(), (id) => d.real.get(id) ?? id, personKey)
      const used = new Set<ToolCall>()
      const toolCalls: ToolCall[] = steps.map((s) => {
        const n = s.detail
        const short = n.replace(/^mcp__inhouse__/, '')
        if (short === 'memory_save' || short === 'memory_update') {
          const w = writes.find((x) => !used.has(x) && x.name === `mcp__inhouse__${short}`)
          if (w) { used.add(w); return w }
          // The call left no row: the product refused it (personal data, a conflict) or it failed. Seen from the rows, not the tool's reply.
          return { name: n, input: {}, result: 'Not saved: no row was written (seen from the brand\'s memory rows, not the tool\'s reply)', isError: true }
        }
        // A seeded fact's product id reads as the seed's id (T04: the case's args name `m_moss`).
        const c = callOfStep(s)
        const seeded = seedIds(c.input, (id) => d.real.get(id))
        return JSON.stringify(seeded) === JSON.stringify(c.input) ? c : { ...c, seedInput: seeded }
      })
      for (const w of writes) if (!used.has(w)) toolCalls.push(w)
      // The parked call, as the open question shows it, if the trace doesn't hold it: its text and options are graded.
      if (parked && !toolCalls.some((c) => c.name === QUESTION_ASK)) {
        toolCalls.push({ name: QUESTION_ASK, input: { question: parked.question, options: parked.options }, result: 'Asked; the chat waits on the answer (seen from the open question, route 140)', isError: false })
      }
      // P5 (#337): the turn must have been sent the system prompt v3 naming Shopify as connected. The static v2 fallback, no
      // version recorded, or a v3 line naming no store fails the run with that reason (never a pass).
      const promptBad = promptFailure(promptSentOf(trace.json))
      // Both causes when the turn also failed otherwise (an error part, an end row): neither hides the other.
      if (promptBad !== null) failure = failure === undefined ? promptBad : `${failure}; ${promptBad}`
      const runOk = answer !== '' && !sawError && promptBad === null
      return { toolCalls, answer, runOk, usage: ZERO, costUsd, turnId, chatId, askedAs: d.askedAs, ...(runOk ? {} : { failure: failure ?? 'unknown' }) }
    },
    async settledCostUsd() {
      return bookCost()
    },
    async reset() {
      await endTurns()
      await d.door.deleteApprovals(seededApprovals)
      await d.door.clear()
    },
  }
}

/**
 * The test issuer's private key from its file. Refusals carry a fixed message: a JSON parse error quotes a slice of its
 * input, and GitHub masks only the whole secret, so a malformed key must never reach the log (ops#14 review N1).
 */
export function readIssuerKey(file: string): JWK {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new ProductTargetRefusal(`refusing: the test issuer's private key file (${EVAL_ISSUER_JWK_FILE}) can't be read`)
  }
  let key: unknown
  try {
    key = JSON.parse(text)
  } catch {
    throw new ProductTargetRefusal('refusing: the test issuer\'s private key file is not valid JSON')
  }
  if (typeof key !== 'object' || key === null || Array.isArray(key)) throw new ProductTargetRefusal('refusing: the test issuer\'s private key file is not a JWK object')
  return key as JWK
}

/** Signs in with a test-issuer token minted from the deployment's private key (a file), the way the e2e specs do. */
export function testIssuerSignIn(env: Record<string, string | undefined>): (key: PersonKey, who?: { sub: string; email: string }) => Promise<Record<string, string>> {
  return async (key, person) => {
    const file = env[EVAL_ISSUER_JWK_FILE]
    const aud = env[EVAL_AUD_VAR]
    if (!file || !aud) throw new ProductTargetRefusal(`refusing: ${EVAL_ISSUER_JWK_FILE} and ${EVAL_AUD_VAR} are not both set, so the eval people can't sign in`)
    const who = person ?? EVAL_PEOPLE[key]
    const token = await mintPerson({ sub: who.sub, email: who.email, key: readIssuerKey(file), aud })
    return { 'Cf-Access-Jwt-Assertion': token, [TEST_ASSERTION_HEADER]: token }
  }
}
