// The product target (W7 PR 2): the real product over HTTP, as the eval people. Per case-repeat it seeds memory (the eval
// deployment's D1, through door.ts), sends each prompt through route 29 in a fresh chat, waits for the turn's end, and reads
// the answer from route 24 and the tool names and settled cost from route 33.
//
// What the API shows decides what can be graded (A8, 2026-11-21): route 33 gives one `tool` step per call with the tool's NAME
// only, route 24 the answer's text parts. No route carries a tool's input or result. So:
//   - tool calls come from route 33's names; a memory write's input comes from the brand's memory rows before and after the chat
//     (a new row is a memory_save, a changed text a memory_update), and a write that left no row is reported as refused;
//   - a case whose grading needs another tool's input or result is "not graded on product" (`unobservable`), with the field named;
//   - cost is the server's settled figure for the turn (route 33's `cost`, whole cents), never the SDK's estimate.
// Cases run one at a time: the brand's memory is shared, so a concurrent case would read another's seeded facts.
import { mintPerson } from '../../server/auth/test-issuer-mint.ts'
import { SEED_PEOPLE } from '../../server/seed/brand.ts'
import { readFileSync } from 'node:fs'
import type { JWK } from 'jose'
import { createDoor, newMemoryId, wranglerRunner, type MemoryDoor, type MemoryRow, type NewMemory } from './door.ts'
import { CapReachedError, type Case, type ChatResult, type ExfilSpec, type People, type PersonKey, type RunContext, type SeedFact, type Session, type Target, type ToolCall } from '../types.ts'

/** The eval brand's monthly Spending cap (decision 18: $40 enforced by us; the $60 workspace limit is the outer stop). */
export const EVAL_CAP = '$40'

export class ProductTargetRefusal extends Error {
  override name = 'ProductTargetRefusal'
}

/** Env flag names: the eval deployment sets both. The first marks the brand as an eval brand, the second names its origin. */
export const EVAL_BRAND_FLAG = 'INHOUSE_EVAL_BRAND'
export const EVAL_ORIGIN_VAR = 'INHOUSE_EVAL_ORIGIN'
/** The deployment's test issuer: the private key (a file) and the brand app's `aud`. The eval deployment is a test build in the sandbox. */
export const EVAL_ISSUER_JWK_FILE = 'INHOUSE_EVAL_ISSUER_JWK_FILE'
export const EVAL_AUD_VAR = 'INHOUSE_EVAL_AUD'
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
  signIn?: (key: PersonKey) => Promise<Record<string, string>>
  /** The memory door. Default: wrangler on INHOUSE_EVAL_D1_NAME (door.ts), made only after the eval-brand check passed. */
  door?: MemoryDoor
  /** Milliseconds between reads while a turn runs. */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** True for an email on `example.test` or a subdomain: the invented domain the seeded brands use. */
export const onExampleTest = (email: string | null): boolean => email !== null && /^[^@\s]+@(?:[a-z0-9-]+\.)*example\.test$/i.test(email)

interface Member { id: string; email: string | null; status: string }

/** Why the product target can't grade a case: a field its API doesn't show. Null when it can. */
export function unobservableReason(c: Case): string | null {
  if (c.exfil?.via === 'history_search') return 'planting through history_search needs a priming chat'
  if (c.exfil?.kind === 'webfetch') return 'WebFetch url and result (route 33 shows the tool name only)'
  for (const chat of c.chats) {
    const args = chat.expect.args
    if (!args) continue
    if ('person_id' in args) return 'memory_save person_id (the product saves only for the person asking; it has no person_id)'
    for (const tool of ([] as string[]).concat(chat.expect.tool ?? [])) {
      if (tool === 'memory_save' || tool === 'memory_update') continue
      return `${tool} input ${Object.keys(args).join(', ')} (route 33 shows the tool name only)`
    }
  }
  return null
}

export function createProductTarget(opts: ProductTargetOptions): Target {
  if (!opts.paid) throw new ProductTargetRefusal('the product target spends real money: pass --paid and --budget <usd>')
  if (!(typeof opts.budgetUsd === 'number' && opts.budgetUsd > 0)) throw new ProductTargetRefusal('the product target needs --budget <usd> above zero')
  if (opts.env[EVAL_BRAND_FLAG] !== '1') throw new ProductTargetRefusal(`refusing: ${EVAL_BRAND_FLAG}=1 is not set, so the brand isn't marked as an eval brand`)
  const origin = opts.env[EVAL_ORIGIN_VAR]
  if (!origin) throw new ProductTargetRefusal(`refusing: ${EVAL_ORIGIN_VAR} is not set`)
  const picker = PICKER_OF[opts.model ?? 'claude-sonnet-5-5']
  if (!picker) throw new ProductTargetRefusal(`refusing: no model picker id for ${JSON.stringify(opts.model)}`)

  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const pollMs = opts.pollMs ?? 2000
  const people: People = { current: '', tom: '', lena: '' }
  const signIn = opts.signIn ?? defaultSignIn(opts.env)
  const headersOf = new Map<PersonKey, Record<string, string>>()

  async function api(who: PersonKey, method: string, path: string, o: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<{ status: number; json: any; text: string }> {
    let h = headersOf.get(who)
    if (!h) headersOf.set(who, (h = await signIn(who)))
    const headers: Record<string, string> = { ...h, ...o.headers }
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
  const must = (r: { status: number; text: string }, what: string, ok: number[] = [200, 201]): void => {
    if (!ok.includes(r.status)) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 200)}`)
  }

  let door: MemoryDoor | undefined = opts.door
  let ready: Promise<void> | undefined
  /** The server-side eval-brand check, then the people's ids and the door. Once, before the first chat. */
  const setup = (): Promise<void> => (ready ??= (async () => {
    for (const k of PEOPLE_KEYS) {
      const me = await api(k, 'GET', '/api/me')
      must(me, `sign in as the eval person ${k}`, [200])
      people[k] = me.json.memberId
    }
    // A5: the brand must be an eval brand on the server's own word, not only on a local env var. There is no server marker, so
    // this is weaker (A8 CHOICE): every member on the brand is an invented example.test address, and the eval people are among them.
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
    if (cursor !== null) throw new ProductTargetRefusal('refusing: the brand has more members than the check reads (100 pages), so it is not known to be an eval brand')
    const live = members.filter((m) => m.status !== 'removed')
    const offenders = live.filter((m) => !onExampleTest(m.email))
    if (offenders.length > 0) throw new ProductTargetRefusal(`refusing: ${offenders.length} member(s) of this brand are not on example.test, so it is not an eval brand`)
    for (const k of PEOPLE_KEYS) if (!live.some((m) => m.id === people[k])) throw new ProductTargetRefusal(`refusing: eval person ${k} is not an active member of this brand`)
    const models = await api('current', 'GET', '/api/models')
    must(models, 'read the models', [200])
    if (!models.json.modes?.some((m: { id: string }) => m.id === picker)) throw new ProductTargetRefusal(`refusing: the brand does not serve the ${picker} model`)
    // (a) the door only after the check passed; (b) and (c) are door.ts's.
    door ??= createDoor(wranglerRunner({ database: opts.env[EVAL_D1_NAME] ?? '', config: opts.env[EVAL_WRANGLER_CONFIG] ?? '', env: opts.env }))
    // The database must be the one this origin answers from: make a chat through the API, read it back through the door. Nothing is
    // cleared or written before this passes.
    const probe = `eval-probe-${rid()}`
    must(await api('current', 'POST', '/api/chats', { json: { id: probe, title: 'Eval probe' } }), 'create the probe chat')
    if (!(await door.hasChat(probe))) throw new ProductTargetRefusal(`refusing: ${EVAL_D1_NAME} does not hold the chat the origin just created, so it is not this deployment's database`)
    // The O2 note: the brand's own Spending cap is the run's $40 (no second ledger). Pinned here, then read back as the
    // product reads it: anything else refuses before any case is seeded.
    await door.setSpendingCap(EVAL_CAP)
    const { spentUsd } = await room()
    // A month already at the cap is refused here, not on the first chat (#253 review O1).
    if (spentUsd >= Number(EVAL_CAP.slice(1))) throw new ProductTargetRefusal(`refusing: this month's spend ($${spentUsd.toFixed(2)}) has reached the ${EVAL_CAP} cap`)
  })())

  /** The month's spend and the cap, from route 42 (the Usage page's numbers) as the Admin eval person. */
  // Every read refuses unless the cap is still the pinned $40 (#253 review O3): a re-seed's $320 or a Settings change can't
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

  let spentTotal = 0
  let tail: Promise<void> = Promise.resolve()

  return {
    name: 'product',
    people,
    // P3 builds none of the shop and mail connectors or routines: the cases that need them report as not run (phase P4/P5).
    provides: new Set<string>(),
    unobservable: unobservableReason,
    spentUsd: () => spentTotal,
    room,
    async seed(memory: SeedFact[], run: RunContext, exfil?: ExfilSpec): Promise<Session> {
      // One case-repeat at a time: the brand's memory is shared.
      const prev = tail
      let release!: () => void
      tail = new Promise<void>((r) => (release = r))
      await prev
      let session: Session
      try {
        await setup()
        const d = door!
        await d.clear()
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
        session = productSession({ api, must, door: d, people, picker, real, attachment, pollMs, sleep, onSpend: (usd) => { spentTotal += usd } })
      } catch (e) {
        release()
        throw e
      }
      return { ...session, async reset() { try { await session.reset() } finally { release() } } }
    },
  }
}

type Api = (who: PersonKey, method: string, path: string, o?: { json?: unknown; bytes?: Uint8Array; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json: any; text: string }>

interface SessionDeps {
  api: Api
  must: (r: { status: number; text: string }, what: string, ok?: number[]) => void
  door: MemoryDoor
  people: People
  picker: string
  /** Real memory id to the case's own id (`m_norda`). */
  real: Map<string, string>
  attachment?: { name: string; bytes: Uint8Array }
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

function productSession(d: SessionDeps): Session {
  const turns: string[] = []
  let booked = 0
  let attachment = d.attachment
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
      let answer = ''
      let sawError = false
      for (;;) {
        if (o?.signal?.aborted) throw new Error('the chat was aborted')
        const page = await d.api('current', 'GET', `/api/chats/${chatId}`, { signal: o?.signal })
        d.must(page, 'read the chat', [200])
        const messages = page.json.messages as { role: string; turnId: string; pos: number; part?: { type: string; text?: string }; end?: { failure?: string; why?: string } }[]
        // The turn's end row: the Spending cap fenced it (stop the run, never a pass), or it ended with no answer at all.
        const end = messages.find((m) => m.role === 'event' && m.turnId === turnId && m.end)?.end
        if (end?.failure === 'cap_reached' || end?.why === 'cap_reached') throw new CapReachedError(turnId)
        const mine = messages.filter((m) => m.role === 'agent' && m.turnId === turnId).sort((a, b) => a.pos - b.pos)
        if (mine.length === 0 && end) {
          sawError = true
          break
        }
        if (mine.length > 0) {
          answer = mine.filter((m) => m.part?.type === 'text').map((m) => m.part!.text ?? '').join('\n\n')
          sawError = mine.some((m) => m.part?.type === 'error')
          break
        }
        await d.sleep(d.pollMs)
      }

      const trace = await d.api('current', 'GET', `/api/traces/${encodeURIComponent(turnId)}`, { signal: o?.signal })
      d.must(trace, 'read the trace', [200])
      const names: string[] = (trace.json.steps as { kind: string; detail: string }[]).filter((s) => s.kind === 'tool').map((s) => s.detail)
      const costUsd = cents(trace.json.cost.minor as number)
      booked += costUsd
      d.onSpend(costUsd)

      const writes = writesFromRows(before, await d.door.rows(), (id) => d.real.get(id) ?? id, personKey)
      const used = new Set<ToolCall>()
      const toolCalls: ToolCall[] = names.map((n) => {
        const short = n.replace(/^mcp__inhouse__/, '')
        if (short === 'memory_save' || short === 'memory_update') {
          const w = writes.find((x) => !used.has(x) && x.name === `mcp__inhouse__${short}`)
          if (w) { used.add(w); return w }
          // The call left no row: the product refused it (personal data, a conflict) or it failed. Seen from the rows, not the tool's reply.
          return { name: n, input: {}, result: 'Not saved: no row was written (seen from the brand\'s memory rows, not the tool\'s reply)', isError: true }
        }
        return { name: n, input: {} }
      })
      for (const w of writes) if (!used.has(w)) toolCalls.push(w)
      return { toolCalls, answer, runOk: answer !== '' && !sawError, usage: ZERO, costUsd }
    },
    async settledCostUsd() {
      return bookCost()
    },
    async reset() {
      await endTurns()
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
function defaultSignIn(env: Record<string, string | undefined>): (key: PersonKey) => Promise<Record<string, string>> {
  return async (key) => {
    const file = env[EVAL_ISSUER_JWK_FILE]
    const aud = env[EVAL_AUD_VAR]
    if (!file || !aud) throw new ProductTargetRefusal(`refusing: ${EVAL_ISSUER_JWK_FILE} and ${EVAL_AUD_VAR} are not both set, so the eval people can't sign in`)
    const who = EVAL_PEOPLE[key]
    const token = await mintPerson({ sub: who.sub, email: who.email, key: readIssuerKey(file), aud })
    return { 'Cf-Access-Jwt-Assertion': token }
  }
}
