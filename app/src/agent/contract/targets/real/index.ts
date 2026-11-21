// The contract suite's real targets: the real client (src/agent/http/) against the test build under `wrangler dev` at
// `origin`. targets.ts appends these when CONTRACT_REAL_ORIGIN is set; from P3 this file is the orchestrator's. One file
// per resource group beside this one holds what is particular to it (me.ts signs in, members.ts resets the team, ...).
//
// It serves exactly the P2 methods. Its client is the product's `HttpAgent` with two additions a browser doesn't need: the
// test issuer's sign-in header and an `Origin` on every request (Node sends neither by itself), and a clock the suite can
// move on (`advance`), which only the client's own notion of "now" follows (a grant stops being live at its end).
import { settingRow } from '../../../../../shared/contract/settings-table'
import { HttpAgent } from '../../../http/client'
import type { AgentClient, AgentErrorCode, ResourceKey } from '../../../types'
import type { ContractTarget, WriteMethod } from '../../targets'
import { FORBIDDEN_PATH, READ_PATH, links } from './audit'
import { endLiveGrant, staleRev } from './grants'
import { discover, signer } from './me'
import type { Seeded, Signer } from './me'
import { resetTeam } from './members'
import { resetSettings, settingFixtures } from './settings'
import { WATCH_READ_PATH, WATCH_SERVED, changeRoutineElsewhere, resetRoutines, seedUnreadNotice, settleRuns, watchBuild, watchRoute } from './watch'

/** The P2 methods: what this target's client serves over HTTP. */
/** How many live Library files `reset()` leaves (the shared Library cases delete one or two). */
const LIBRARY_FILES = 2

const SERVED: ReadonlySet<keyof AgentClient> = new Set<keyof AgentClient>([
  'me', 'inviteMember', 'setMemberRole', 'removeMember', 'grantSupport', 'endSupportGrant', 'loadMore', 'retry', 'auditExportUrl', 'signOutUrl',
  'setSetting', 'setToggle', 'setPhoto',
  // P4 W5 (p4-w5.md addendum, #256 review): the Library.
  'listFiles', 'deleteFiles', 'restoreFiles', 'uploadFiles', 'fileDownloadUrl',
  // P4 W6 (watch.ts): the routines, the bell and Today's set-aside.
  ...WATCH_SERVED,
])

const WRITES: ReadonlySet<string> = new Set<WriteMethod>([
  'approve', 'undo', 'editDraft', 'undoHandled', 'redoHandled', 'createChat', 'pause', 'resume', 'setToggle', 'requestTool', 'requestSkill', 'setToolPaused',
  'forgetMemory', 'setSetting', 'setPhoto', 'sendTeamRequest', 'markNoticesRead', 'deleteFiles', 'restoreFiles', 'setAside', 'runRoutine', 'deleteRoutine',
  'restoreRoutine', 'renameChat', 'pinChat', 'deleteChats', 'restoreChats', 'inviteMember', 'setMemberRole', 'removeMember', 'grantSupport', 'endSupportGrant',
])

/** The route a served write method's call sends to: its verbs and the exact path (the key or the id in it too), from the call's arguments. */
function routeOf(method: WriteMethod, args: unknown[]): { verbs: string[]; path: string } | null {
  const enc = (v: unknown) => encodeURIComponent(String(v))
  switch (method) {
    case 'setSetting': case 'setToggle': {
      const row = settingRow(String(args[0]))
      return row ? { verbs: ['PUT'], path: `/api/settings/${row.scope}/${enc(args[0])}` } : watchRoute(method, args)
    }
    case 'setPhoto': return { verbs: ['PUT', 'DELETE'], path: '/api/photo' }
    case 'inviteMember': return { verbs: ['POST'], path: '/api/members/invites' }
    case 'setMemberRole': return { verbs: ['PUT'], path: `/api/members/${enc(args[0])}/role` }
    case 'removeMember': return { verbs: ['DELETE'], path: `/api/members/${enc(args[0])}` }
    case 'grantSupport': return { verbs: ['POST'], path: '/api/grants' }
    case 'endSupportGrant': return { verbs: ['POST'], path: `/api/grants/${enc(args[0])}/end` }
    case 'deleteFiles': return { verbs: ['POST'], path: '/api/library/delete' }
    case 'restoreFiles': return { verbs: ['POST'], path: '/api/library/restore' }
    default: return watchRoute(method, args)
  }
}

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
  let forced: { code: AgentErrorCode; verbs: string[]; path: string } | null = null
  const armedErrors = new Map<string, AgentErrorCode>()
  const armedReads = new Set<ResourceKey>()
  let staleGrantEnd = false

  const wire: typeof fetch = async (input, init) => {
    const url = new URL(String(input), origin)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && failAllSaves) return refusal('unavailable')
    // An armed refusal answers the next request to the armed call's own URL (the key or id in it too), so a write to another record, made meanwhile, isn't refused.
    if (forced !== null && forced.verbs.includes(method) && forced.path === url.pathname) { const code = forced.code; forced = null; return refusal(code) }
    if (method === 'GET') {
      for (const resource of armedReads) {
        if ((READ_PATH[resource] ?? WATCH_READ_PATH[resource]) === url.pathname) { armedReads.delete(resource); return fetch(origin + FORBIDDEN_PATH, init) }
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
      // On the watch build a Run now is settled before the call returns (its manual slot ends), so the next one can't hit a run-open conflict (watch.ts settleRuns); a containerless build can't end one, so it does not wait.
      const settled = (p: Promise<unknown>): Promise<unknown> => (prop === 'runRoutine' && watchBuild() ? p.then(async v => { await settleRuns(); return v }, async e => { await settleRuns(); throw e }) : p)
      return (...args: unknown[]) => {
        const code = armedErrors.get(prop)
        if (!code) return settled(method(...args) as Promise<unknown>)
        const route = routeOf(prop as WriteMethod, args)
        forced = route ? { code, ...route } : null
        const done = method(...args) as Promise<unknown>
        const clear = () => { forced = null }
        done.then(clear, clear)
        return settled(done)
      }
    },
  }) as unknown as AgentClient

  /** The Loading scenario's client never hears back: a later scenario needs a client that does. */
  let hung = false
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
      // Filled in by `reset()` with the Admin's photo URL.
      photoAfterSet: '',
      teamRequest: { icon: 'build', title: 'Connect Klaviyo', sub: 'From Settings', at: { iso: '2026-11-19T14:04:00.000Z', ms: Date.UTC(2026, 10, 19, 14, 4) }, status: 'Requested' },
      newChat: { id: 'contract-chat-1', title: 'A new chat' },
      paddedTitle: '  Padded   title  ',
      paddedTitleTrimmed: 'Padded title',
      unknownChatId: 'no-such-chat',
      unknownTraceId: 'no-such-trace',
    },
    // Each property run resets the team, the Admin's grants and the settings the cases write, and makes several HTTP round trips; 20 runs keep a property inside the 25 s timeout.
    propertyRuns: 20,
    failedSaveNotice: 'error',
    capabilities: { agentWritesSaveInClient: false, pagesLists: true, adminCanDoEverything: false, keepsFiles: true },
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
      await resetSettings(s)
      // Only a build with containers can end a Run now: a containerless one (CI's contract step) would wait out the deadline.
      if (watchBuild()) await settleRuns()
      await resetRoutines(s)
      await seedUnreadNotice()
      this.fixtures.personId = seeded.admin
      this.fixtures.photoAfterSet = new RegExp(`^/api/members/${seeded.admin}/photo\\?v=[0-9a-f]{32}$`) // a member id is base64url: nothing to escape
      this.fixtures.me = { memberId: seeded.admin, role: 'admin' }
      this.fixtures.otherMemberId = seeded.leo
      hung = false
      install(make('admin'))
      await agent.whenLoaded()
      // The Library cases need two live files; the test build starts with none, and a case may leave one deleted.
      const live = agent.listFiles().length
      if (live < LIBRARY_FILES) await agent.uploadFiles(Array.from({ length: LIBRARY_FILES - live }, (_, i) => new File([`sku,qty\nA${i},1\n`], `contract file ${i}.csv`, { type: 'text/csv' })))
    },
    async seed(state) {
      // The test build has one brand and no stages or scenarios; the Loading scenario is a client that hasn't heard back.
      if (state.scenario === 'Loading') { hung = true; install(make('admin', { fetch: hanging })) }
      else {
        if (hung) { hung = false; install(make('admin')) }
        await agent.whenLoaded()
      }
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
      } else if (record.kind === 'file') {
        // A delete and a restore in the other session: the file is as it was, two revisions on.
        await other.deleteFiles([record.id])
        await other.restoreFiles([record.id])
      } else if (record.kind === 'routine') {
        await changeRoutineElsewhere(other, record.id)
      } else throw new Error(`The real target has no ${record.kind} to change elsewhere.`)
    },
    async failRead(resource) {
      if (!READ_PATH[resource] && !WATCH_READ_PATH[resource]) throw new Error(`The real client reads no "${resource}" resource in P2, so none can fail.`)
      armedReads.add(resource)
      await agent.retry(resource)
    },
  }
}

export function realTargets(origin: string): ContractTarget[] {
  return [realTarget(origin)]
}
