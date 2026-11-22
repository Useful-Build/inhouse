// The clients the contract suite runs against. The suite never reaches past `ContractTarget`, so the real client (P2,
// under `wrangler dev`) joins this list with its own target and no test changes. That means everything a test needs from
// its target goes through it: time (`advance`), seeding, resets, forced failures, injected errors and every id, name and
// scripted question (`fixtures`). Every method that touches the client's world is async: a real target talks over HTTP.
import { inject, vi } from 'vitest'
import type { AgentClient, AgentErrorCode, AgentNotice, AgentState, DemoContext, InviteInput, ResourceKey, TeamRequest } from '../types'
import { AgentError } from '../types'
import type { MockAgent, ScriptedTurn } from '../mock'
import { ME_ID, memberIdOf } from '../mock'
import { realTargets } from './targets/real/index'

/** Every client method that writes and returns a promise: the ones `injectError` can fail. */
export type WriteMethod =
  | 'approve' | 'undo' | 'editDraft' | 'undoHandled' | 'redoHandled' | 'createChat' | 'pause' | 'resume' | 'setToggle'
  | 'requestTool' | 'requestSkill' | 'setToolPaused' | 'connectTool' | 'disconnectTool' | 'forgetMemory' | 'setSetting' | 'setPhoto' | 'sendTeamRequest'
  | 'markNoticesRead' | 'deleteFiles' | 'restoreFiles' | 'setAside' | 'runRoutine' | 'deleteRoutine' | 'restoreRoutine'
  | 'renameChat' | 'pinChat' | 'deleteChats' | 'restoreChats'
  | 'inviteMember' | 'setMemberRole' | 'removeMember' | 'grantSupport' | 'endSupportGrant'
  // P5 (p5-w4): the Slack notice channel list.
  | 'saveNotifyChannels'

/** A record a test changes behind the client (`writeElsewhere`), so the client's next write to it is stale. */
export type RecordRef =
  | { kind: 'setting'; key: string }
  | { kind: 'member'; id: string }
  | { kind: 'grant'; id: string }
  | { kind: 'routine' | 'memory' | 'file' | 'chat'; id: string }

/** What the suite uses from the world it runs in. A target supplies values that exist there; the tests name none themselves. */
export interface Fixtures {
  /** How long an approved draft is held before it goes out, in ms on the client's clock (the 10 s hold). */
  holdMs: number
  questions: {
    /** A question the agent answers with text and a table, in every stage. */
    table: string
    /** A question that asks for an approval (a draft) in Act and is refused in Watch (it can't approve there). */
    approval: string
    /** A question the agent has no script for: it answers with what it can do and the suggested questions. */
    offScript: string
    /** A request for a routine that has a day and a time. */
    routineRequest: string
    /** A request to make a skill. */
    skillRequest: string
    /** A question that needs the tool the Tool disconnected scenario disconnects. */
    disconnectedTool: string
    /** What a person types into a running answer. */
    followUp: string
    /** What a person types into an answer that has ended. */
    tooLate: string
  }
  toggleKey: string
  toolKey: string
  skillName: string
  memoryKey: string
  settingKey: string
  settingValue: string
  /** A member's id: the signed-in Admin. `setPhoto` takes it. */
  personId: string
  /** The signed-in person (`me()`): the Admin, who the first-run team has as its only Admin. */
  me: { memberId: string; role: 'member' | 'admin' }
  /** Another active member who isn't an Admin: the one a role is changed on. */
  otherMemberId: string
  /** An invitation for someone not on the team. */
  invite: InviteInput
  /** A second setting, so two writes can be told apart (`settingKey` is the first). */
  otherSetting: { key: string; value: string }
  /** What `auditExportUrl()` and `signOutUrl()` return on this target: the demo builds the CSV itself and has no sign-in (null, null); the product names both paths. */
  links: { auditExport: string | null; signOut: string | null }
  /** One setting key with three valid values, for the stale-write property. */
  choices: { key: string; values: [string, string, string] }
  photoDataUrl: string
  /** What a member's `photo` reads as after `setPhoto(personId, photoDataUrl)`: the demo keeps the picture as sent, the product serves it from `/api/members/<id>/photo?v=<the photo's version>` (a pattern: the version is the server's). */
  photoAfterSet: string | RegExp
  teamRequest: TeamRequest
  newChat: { id: string; title: string }
  /** The picker's model id a send names (`sonnet`). A target that names none uses `sonnet`. */
  model?: string
  /** A title with spaces round it: `renameChat` trims it to `paddedTitleTrimmed`. */
  paddedTitle: string
  paddedTitleTrimmed: string
  unknownChatId: string
  unknownTraceId: string
}

export interface ContractTarget {
  name: string
  /** The client in use now. `reset()` replaces it, so read it fresh in each test, and subscribe again after a reset. */
  readonly client: AgentClient
  fixtures: Fixtures
  /** The most runs a property test makes on this target (the env's count when smaller). A target over HTTP sets it: each run is several round trips. The mock leaves it unset. */
  propertyRuns?: number
  /** Before each test: take control of time. The mock uses vitest's fake timers; a real target starts its dev clock. */
  setup(): Promise<void>
  /** After each test: give time back. */
  teardown(): Promise<void>
  /** The notice kind a write that couldn't save sends: the mock's `save.failed` (as `types.ts` says), a server's `error`. Tests assert exactly this. */
  failedSaveNotice: 'save.failed' | 'error'
  capabilities: {
    /**
     * Writes the agent makes by itself (the hold's send, a routine or skill an answer creates) are saves in the client, so
     * `failSaves` can fail them. True on the mock only: on a server they happen server-side, and P2 adds its own case.
     */
    agentWritesSaveInClient: boolean
    /** True when a list can have a next page (the server pages the audit log and members); false on the mock, which returns every list whole: `more` is false and `loadMore` does nothing. */
    pagesLists: boolean
    /** True on the demo: its Admin may do everything (`me().can` all true). A product target's Admin has what the server's access rows give an Admin. */
    adminCanDoEverything: boolean
    /** True when the client keeps uploaded files and serves downloads (a product target, P4 W5); false on the demo, which refuses uploads as `unavailable` and has no download URLs. */
    keepsFiles: boolean
  }
  /** Let what is in flight arrive without moving the clock: microtasks flushed (the mock), delivery awaited (a server). Called before each `advance`. */
  settle(): Promise<void>
  /**
   * Move the client's clock on by `ms`: holds end, answers stream, timers fire. The tests never wait on real time. It
   * resolves only once the effects of that time are delivered (state changed, listeners and notices told), so a test
   * reads the result right after it without waiting again. A server target must await its delivery here too.
   */
  advance(ms: number): Promise<void>
  /** Back to a first-run state: no writes, no saved runs, no pending holds, no failures armed. */
  reset(): Promise<void>
  /** Put the client in a stage and scenario (the demo's dev switcher). Resolves only once the client shows the new world: `read()` is the new data and `subscribe` listeners have heard it. */
  seed(state: DemoContext): Promise<void>
  /**
   * Make every write fail to save (true) or work again (false). For the mock that is the browser's storage refusing a
   * write (the person gets a `save.failed` notice). For a server it means every write request comes back with an error
   * response (a 5xx the client can't tell apart from a lost connection). The client takes the write back either way.
   */
  failSaves(on: boolean): Promise<void>
  /**
   * Make one method fail with an `AgentError` of this code after it was applied optimistically (null: work again): the
   * server answered 403, 409 or 5xx. The client takes the write back and sends one `error` notice with that code.
   * On the mock this is a proxy in this file, so the injected-refusal tests exercise the proxy and the client's rollback
   * path, not the mock itself; they become real checks of a server with P2's target.
   */
  injectError(method: WriteMethod, code: AgentErrorCode | null): Promise<void>
  /** Whether this target serves a client method. The suite skips (by name) the tests of a method a target doesn't serve; the mock serves all of them. */
  serves(method: keyof AgentClient): boolean
  /** Change a record behind the client, as another session would, so the client's next write to it is stale and rejects with `conflict` carrying the current record. `value` is the new value (a role, a setting's value; a grant is ended). */
  writeElsewhere(record: RecordRef, value?: string | boolean): Promise<void>
  /** Make the next turn of any chat end as `kind` says (a spending cap, a busy budget, a damaged session, a crash). A target that can't script it leaves this out and the suite skips those cases. */
  scriptNextTurn?(kind: ScriptedTurn | null): Promise<void>
  /** Make the next read of a resource fail (`read().resources[resource].status` is `error` until `client.retry(resource)`). */
  failRead(resource: ResourceKey): Promise<void>
}

// The mock saves to the browser's storage. Vitest runs in node, so a Map stands in, with a switch that makes a write throw.
const storage = new Map<string, string>()
let savesFail = false
const shim = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (savesFail) throw new Error('QuotaExceededError (forced by the contract suite)')
    storage.set(k, String(v))
  },
  removeItem: (k: string) => { storage.delete(k) },
  clear: () => storage.clear(),
}
Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true })

// Imported after the shim: the entry builds the mock, which reads storage when it loads. The target runs on the demo entry
// itself (the client the app gets from `src/agent/index.ts`) and resets it with `demo.reset()`, as the demo's Reset does.
// The entry, not the mock on its own: it is what sets display.ts's clock (`setNow`), which every relative label reads.
const { agent: entryAgent, demo } = await import('../index')
if (!demo) throw new Error('The contract suite needs the demo entry (its mock and demo.reset()); is @client the product entry?')
const mockAgent = entryAgent as MockAgent
// The chat engine loads in the background in the app; the suite's fake clock mustn't wait on it.
await mockAgent.preload()

/** Where the mock saves its state (its own constant isn't exported): the proxy keeps this in step when it takes a change back. */
const MOCK_STORAGE_KEY = 'inhouse.demo.v2'

const WRITE_METHODS: ReadonlySet<string> = new Set<WriteMethod>([
  'approve', 'undo', 'editDraft', 'undoHandled', 'redoHandled', 'createChat', 'pause', 'resume', 'setToggle', 'requestTool',
  'requestSkill', 'setToolPaused', 'connectTool', 'disconnectTool', 'forgetMemory', 'setSetting', 'setPhoto', 'sendTeamRequest', 'markNoticesRead', 'deleteFiles',
  'restoreFiles', 'setAside', 'runRoutine', 'deleteRoutine', 'restoreRoutine', 'renameChat', 'pinChat', 'deleteChats', 'restoreChats',
  'inviteMember', 'setMemberRole', 'removeMember', 'grantSupport', 'endSupportGrant',
  'saveNotifyChannels',
])

/** The parts of the mock an injected failure has to undo. Test-only access: the mock has no hook for a server's refusal. */
interface MockInternals {
  state: AgentState
  /** The server's side of the mock (members, photos, the grant, every rev), taken back with the state. */
  server: unknown
  /** What the mock saves under its storage key: the state with the demo's start. */
  saved(): string
  listeners: Set<() => void>
  created: Set<string>
  holdTimers: Record<string, ReturnType<typeof setTimeout>>
  notify(n: AgentNotice): void
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The mock behind a Proxy that fails the armed methods the way a server's refusal would: after the change showed. */
function injecting(mock: MockAgent, armed: Map<string, AgentErrorCode>): AgentClient {
  const inner = mock as unknown as MockInternals
  return new Proxy(mock, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target)
      if (typeof member !== 'function') return member
      const method = (member as (...a: unknown[]) => unknown).bind(target)
      if (typeof prop !== 'string' || !WRITE_METHODS.has(prop)) return method
      return (...args: unknown[]) => {
        const code = armed.get(prop)
        if (!code) return method(...args)
        const before = inner.state
        const serverBefore = inner.server
        const created = new Set(inner.created)
        const timers = new Set(Object.keys(inner.holdTimers))
        const applied = method(...args) as Promise<unknown>
        const optimistic = inner.state
        const serverOptimistic = inner.server
        // What this call itself added: a write made later (an approve's hold timer, say) isn't in these and survives the refusal.
        const addedCreated = [...inner.created].filter(id => !created.has(id))
        const addedTimers = Object.keys(inner.holdTimers).filter(id => !timers.has(id))
        // What this call changed: the state keys it replaced. Only those are taken back, so a write made in between stays.
        const changed = (Object.keys(optimistic) as (keyof AgentState)[]).filter(k => optimistic[k] !== before[k])
        const refused = applied.then(async () => {
          // The server said no: take this change back (not the whole state), save what is left, tell the listeners and the person.
          const now = inner.state
          const kept: Record<string, unknown> = { ...now }
          for (const k of changed) {
            if (now[k] === optimistic[k]) { kept[k] = before[k]; continue }
            // A concurrent write replaced the same record: take back only the entries this call changed.
            const [was, mine, cur]: unknown[] = [before[k], optimistic[k], now[k]]
            if (!isRecord(was) || !isRecord(mine) || !isRecord(cur)) continue
            const entries: Record<string, unknown> = { ...cur }
            for (const e of new Set([...Object.keys(was), ...Object.keys(mine)])) {
              if (was[e] === mine[e] || cur[e] !== mine[e]) continue
              if (e in was) entries[e] = was[e]; else delete entries[e]
            }
            kept[k] = entries
          }
          // Nothing else changed meanwhile: the old state object itself comes back, so its identity does too.
          inner.state = now === optimistic ? before : (kept as unknown as AgentState)
          // The server's side goes back too, unless something else wrote to it meanwhile.
          if (inner.server === serverOptimistic) inner.server = serverBefore
          storage.set(MOCK_STORAGE_KEY, inner.saved())
          for (const id of addedCreated) inner.created.delete(id)
          for (const id of addedTimers) if (id in inner.holdTimers) { clearTimeout(inner.holdTimers[id]); delete inner.holdTimers[id] }
          inner.listeners.forEach(l => l())
          const text = `The server refused ${prop} (${code}).`
          inner.notify({ type: 'error', code, text })
          throw new AgentError(code, text)
        })
        refused.catch(() => undefined) // a caller that doesn't await still gets its notice and no unhandled rejection
        return refused
      }
    },
  }) as unknown as AgentClient
}

function mockTarget(): ContractTarget {
  const armed = new Map<string, AgentErrorCode>()
  let proxy = injecting(mockAgent, armed)
  return {
    name: 'mock',
    get client() { return proxy },
    fixtures: {
      holdMs: 10_000,
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
      toggleKey: 'r:Morning check',
      toolKey: 'klaviyo',
      skillName: 'Stock check',
      memoryKey: 'some-line',
      settingKey: 'g:name',
      settingValue: 'Sam Example',
      personId: ME_ID,
      me: { memberId: ME_ID, role: 'admin' },
      otherMemberId: memberIdOf('priya'),
      invite: { name: 'Robin Example', email: 'robin@example.test', title: 'Operations', role: 'member' },
      otherSetting: { key: 'g:lang', value: 'Français' },
      links: { auditExport: null, signOut: null },
      choices: { key: 'g:tz', values: ['Europe/London', 'America/Chicago', 'Australia/Sydney'] },
      photoDataUrl: 'data:image/png;base64,AAAA',
      photoAfterSet: 'data:image/png;base64,AAAA',
      teamRequest: { icon: 'build', title: 'Connect Klaviyo', sub: 'From Settings', at: { iso: '2026-11-19T14:04:00.000Z', ms: Date.UTC(2026, 10, 19, 14, 4) }, status: 'Requested' },
      newChat: { id: 'contract-chat-1', title: 'A new chat' },
      model: 'sonnet',
      paddedTitle: '  Padded   title  ',
      paddedTitleTrimmed: 'Padded title',
      unknownChatId: 'no-such-chat',
      unknownTraceId: 'no-such-trace',
    },
    failedSaveNotice: 'save.failed',
    capabilities: { agentWritesSaveInClient: true, pagesLists: false, adminCanDoEverything: true, keepsFiles: false },
    async setup() { vi.useFakeTimers() },
    async teardown() { vi.useRealTimers() },
    async settle() { await vi.advanceTimersByTimeAsync(0) },
    async advance(ms) { await vi.advanceTimersByTimeAsync(ms) },
    async reset() {
      savesFail = false
      armed.clear()
      demo!.reset()
      proxy = injecting(mockAgent, armed)
    },
    async seed(state) { demo!.setDemo(state) },
    async failSaves(on) { savesFail = on },
    async injectError(method, code) { if (code) armed.set(method, code); else armed.delete(method) },
    serves: () => true,
    async writeElsewhere(record, value) { mockAgent.changeElsewhere(record, value) },
    async failRead(resource) { mockAgent.failRead(resource) },
    async scriptNextTurn(kind) { mockAgent.scriptNextTurn(kind) },
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    /** CONTRACT_REAL_ORIGIN, or '' (vitest.config.ts reads it from the environment). */
    contractRealOrigin: string
  }
}

// CONTRACT_REAL_ORIGIN (the test build's origin, e.g. http://brand.localhost:8787): also run the suite on the real
// client against it (src/agent/contract/targets/real/). vitest.config.ts hands it over with `provide`.
export const realOrigin: string | undefined = inject('contractRealOrigin') || undefined
/** The real targets for `origin` (none without one). `make` is for targets.test.ts, which proves the origin reaches it. */
export function realTargetsFor(origin: string | undefined, make: (origin: string) => ContractTarget[] = realTargets): ContractTarget[] {
  return origin ? make(origin) : []
}
export const targets: ContractTarget[] = [mockTarget(), ...realTargetsFor(realOrigin)]
