// The contract suite's real targets: the real client (src/agent/http/) against the test build under `wrangler dev` at
// `origin`. targets.ts appends these when CONTRACT_REAL_ORIGIN is set; from P3 this file is the orchestrator's. One file
// per resource group beside this one holds what is particular to it (me.ts signs in, members.ts resets the team, ...).
//
// It serves exactly the P2 methods. Its client is the product's `HttpAgent` with two additions a browser doesn't need: the
// test issuer's sign-in header and an `Origin` on every request (Node sends neither by itself), and a clock the suite can
// move on (`advance`), which only the client's own notion of "now" follows (a grant stops being live at its end).
import { HttpAgent } from '../../../http/client'
import type { AgentClient, AgentErrorCode, ResourceKey } from '../../../types'
import type { ContractTarget, WriteMethod } from '../../targets'
import { FORBIDDEN_PATH, READ_PATH, links } from './audit'
import { endLiveGrant, staleRev } from './grants'
import { discover, signer } from './me'
import type { Seeded, Signer } from './me'
import { resetTeam } from './members'
import { settingFixtures } from './settings'

/** The P2 methods: what this target's client serves over HTTP. */
const SERVED: ReadonlySet<keyof AgentClient> = new Set<keyof AgentClient>([
  'me', 'inviteMember', 'setMemberRole', 'removeMember', 'grantSupport', 'endSupportGrant', 'loadMore', 'retry', 'auditExportUrl', 'signOutUrl',
  'setSetting', 'setToggle', 'setPhoto',
])

const WRITES: ReadonlySet<string> = new Set<WriteMethod>([
  'approve', 'undo', 'editDraft', 'undoHandled', 'redoHandled', 'createChat', 'pause', 'resume', 'setToggle', 'requestTool', 'requestSkill', 'setToolPaused',
  'forgetMemory', 'setSetting', 'setPhoto', 'sendTeamRequest', 'markNoticesRead', 'deleteFiles', 'restoreFiles', 'setAside', 'runRoutine', 'deleteRoutine',
  'restoreRoutine', 'renameChat', 'pinChat', 'deleteChats', 'restoreChats', 'inviteMember', 'setMemberRole', 'removeMember', 'grantSupport', 'endSupportGrant',
])

const STATUS: Record<AgentErrorCode, number> = {
  invalid: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, rate_limited: 429, cap_reached: 429, unavailable: 503, unknown: 500, offline: 503,
}
const refusal = (code: AgentErrorCode) => new Response(JSON.stringify({ error: { code } }), { status: STATUS[code], headers: { 'Content-Type': 'application/json' } })

/** A 1 by 1 PNG: the server reads the type from the bytes, so the fixture has to be a real picture. */
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

function realTarget(origin: string): ContractTarget {
  const s: Signer = signer(origin)
  let ids: Awaited<ReturnType<typeof discover>> | undefined
  const ready = async () => (ids ??= await discover(s))

  // What the target does to the client's requests, the way a failing network or server would.
  let clockOffset = 0
  let failAllSaves = false
  let forced: AgentErrorCode | null = null
  const armedErrors = new Map<string, AgentErrorCode>()
  const armedReads = new Set<ResourceKey>()
  let staleGrantEnd = false

  const wire: typeof fetch = async (input, init) => {
    const url = new URL(String(input), origin)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && (failAllSaves || forced !== null)) return refusal(forced ?? 'unavailable')
    if (method === 'GET') {
      for (const resource of armedReads) {
        if (READ_PATH[resource] === url.pathname) { armedReads.delete(resource); return fetch(origin + FORBIDDEN_PATH, init) }
      }
    }
    if (staleGrantEnd && method === 'POST' && /^\/api\/grants\/[^/]+\/end$/.test(url.pathname) && typeof init?.body === 'string') {
      staleGrantEnd = false
      return fetch(input, { ...init, body: JSON.stringify(staleRev(JSON.parse(init.body))) })
    }
    return fetch(input, init)
  }
  const hanging: typeof fetch = () => new Promise<Response>(() => undefined)

  const make = (who: Seeded, over: { fetch?: typeof fetch } = {}) => new HttpAgent({ origin, fetch: over.fetch ?? wire, headers: s.headers(who), now: () => Date.now() + clockOffset })

  /** The client under test, behind a proxy that fails an armed write the way a server's refusal would: after the change showed. */
  const injecting = (agent: HttpAgent): AgentClient => new Proxy(agent, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target)
      if (typeof member !== 'function') return member
      const method = (member as (...a: unknown[]) => unknown).bind(target)
      if (typeof prop !== 'string' || !WRITES.has(prop)) return method
      return (...args: unknown[]) => {
        const code = armedErrors.get(prop)
        if (!code) return method(...args)
        forced = code
        const done = method(...args) as Promise<unknown>
        const clear = () => { forced = null }
        done.then(clear, clear)
        return done
      }
    },
  }) as unknown as AgentClient

  let agent = make('admin')
  let client = injecting(agent)
  const install = (next: HttpAgent) => { agent = next; client = injecting(next) }

  /** A second session of the same person: a change made through it is one the first doesn't know of. */
  const elsewhere = async (): Promise<HttpAgent> => {
    const other = new HttpAgent({ origin, fetch: (i, init) => fetch(i, init), headers: s.headers('admin') })
    await other.whenLoaded()
    return other
  }

  return {
    name: 'real',
    get client() { return client },
    fixtures: {
      holdMs: 10_000,
      // Not served in P2 (a run, a tool, a skill, memory): the names are the mock's, so the fixtures type is whole.
      questions: {
        table: 'Which orders are stuck over 3 days?',
        approval: 'Chase ShipBob on #4821, and check for stuck orders every morning from now on.',
        offScript: 'Please translate this into Klingon',
        routineRequest: 'Every Monday at 9 AM send me the refund numbers',
        skillRequest: 'Please create a skill that checks stock levels',
        disconnectedTool: 'How many Gorgias tickets about refunds are open?',
        followUp: 'And which are over $500?',
        tooLate: 'Too late',
      },
      toolKey: 'klaviyo',
      skillName: 'Stock check',
      memoryKey: 'some-line',
      ...settingFixtures,
      // Filled in by `reset()`, from the seed: an id is random, so no test names one.
      personId: '',
      me: { memberId: '', role: 'admin' },
      otherMemberId: '',
      invite: { name: 'Robin Example', email: 'robin@example.test', title: 'Operations', role: 'member' },
      links,
      photoDataUrl: PNG_1X1,
      teamRequest: { icon: 'build', title: 'Connect Klaviyo', sub: 'From Settings', at: { iso: '2026-11-19T14:04:00.000Z', ms: Date.UTC(2026, 10, 19, 14, 4) }, status: 'Requested' },
      newChat: { id: 'contract-chat-1', title: 'A new chat' },
      paddedTitle: '  Padded   title  ',
      paddedTitleTrimmed: 'Padded title',
      unknownChatId: 'no-such-chat',
      unknownTraceId: 'no-such-trace',
    },
    failedSaveNotice: 'error',
    capabilities: { agentWritesSaveInClient: false, pagesLists: true },
    async setup() { /* a server's clock isn't ours to take: `advance` moves the client's own */ },
    async teardown() { /* nothing to give back */ },
    async settle() { await agent.whenLoaded() },
    async advance(ms) { clockOffset += ms; await agent.whenLoaded() },
    async reset() {
      failAllSaves = false; forced = null; staleGrantEnd = false; clockOffset = 0
      armedErrors.clear(); armedReads.clear()
      const seeded = await ready()
      await resetTeam(s)
      await endLiveGrant(s)
      this.fixtures.personId = seeded.admin
      this.fixtures.me = { memberId: seeded.admin, role: 'admin' }
      this.fixtures.otherMemberId = seeded.leo
      install(make('admin'))
      await agent.whenLoaded()
    },
    async seed(state) {
      // The test build has one brand and no stages or scenarios; the Loading scenario is a client that hasn't heard back.
      if (state.scenario === 'Loading') install(make('admin', { fetch: hanging }))
      else await agent.whenLoaded()
    },
    async failSaves(on) { failAllSaves = on },
    async injectError(method, code) { if (code) armedErrors.set(method, code); else armedErrors.delete(method) },
    serves: method => SERVED.has(method),
    async writeElsewhere(record, value) {
      const other = await elsewhere()
      if (record.kind === 'setting') {
        if (typeof value === 'boolean') await other.setToggle(record.key, value)
        else await other.setSetting(record.key, typeof value === 'string' ? value : null)
      } else if (record.kind === 'member') {
        await other.setMemberRole(record.id, value === 'member' ? 'member' : 'admin')
      } else if (record.kind === 'grant') {
        if (value === 'end') await other.endSupportGrant(record.id)
        else staleGrantEnd = true
      } else throw new Error(`The real target has no ${record.kind} to change elsewhere in P2.`)
    },
    async failRead(resource) {
      if (!READ_PATH[resource]) throw new Error(`The real client reads no "${resource}" resource in P2, so none can fail.`)
      armedReads.add(resource)
      await agent.retry(resource)
    },
  }
}

export function realTargets(origin: string): ContractTarget[] {
  return [realTarget(origin)]
}
