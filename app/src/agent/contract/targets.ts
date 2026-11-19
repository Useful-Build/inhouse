// The clients the contract suite runs against. The suite never reaches past `ContractTarget`, so the real client (P2,
// under `wrangler dev`) joins this list with its own target and no test changes. That means everything a test needs from
// its target goes through it: time (`advance`), seeding, resets, forced failures, injected errors and every id, name and
// scripted question (`fixtures`). Every method that touches the client's world is async: a real target talks over HTTP.
import { vi } from 'vitest'
import type { AgentClient, AgentErrorCode, AgentNotice, AgentState, DemoContext } from '../types'
import { AgentError } from '../types'
import type { MockAgent } from '../mock'

/** Every client method that writes and returns a promise: the ones `injectError` can fail. */
export type WriteMethod =
  | 'approve' | 'undo' | 'editDraft' | 'undoHandled' | 'redoHandled' | 'createChat' | 'pause' | 'resume' | 'setToggle'
  | 'requestTool' | 'requestSkill' | 'setToolPaused' | 'forgetMemory' | 'setSetting' | 'setPhoto' | 'sendTeamRequest'
  | 'markNoticesRead' | 'deleteFiles' | 'restoreFiles' | 'setAside' | 'runRoutine' | 'deleteRoutine' | 'restoreRoutine'
  | 'renameChat' | 'pinChat' | 'deleteChats' | 'restoreChats'

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
  personId: string
  photoDataUrl: string
  teamRequest: { icon: string; title: string; sub: string; status: string }
  newChat: { id: string; title: string }
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
  }
  /** Let what is in flight arrive without moving the clock: microtasks flushed (the mock), delivery awaited (a server). Called before each `advance`. */
  settle(): Promise<void>
  /** Move the client's clock on by `ms`: holds end, answers stream, timers fire. The tests never wait on real time. */
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

// Imported after the shim: the mock reads storage when it loads. Until W4 merges, `reset()` makes a fresh instance;
// W4 adds `demo.reset()` and this target switches to it.
const { MockAgent: Mock } = await import('../mock')

/** Where the mock saves its state (its own constant isn't exported): the proxy keeps this in step when it takes a change back. */
const MOCK_STORAGE_KEY = 'inhouse.demo.v2'

const WRITE_METHODS: ReadonlySet<string> = new Set<WriteMethod>([
  'approve', 'undo', 'editDraft', 'undoHandled', 'redoHandled', 'createChat', 'pause', 'resume', 'setToggle', 'requestTool',
  'requestSkill', 'setToolPaused', 'forgetMemory', 'setSetting', 'setPhoto', 'sendTeamRequest', 'markNoticesRead', 'deleteFiles',
  'restoreFiles', 'setAside', 'runRoutine', 'deleteRoutine', 'restoreRoutine', 'renameChat', 'pinChat', 'deleteChats', 'restoreChats',
])

/** The parts of the mock an injected failure has to undo. Test-only access: the mock has no hook for a server's refusal. */
interface MockInternals {
  state: AgentState
  listeners: Set<() => void>
  created: Set<string>
  holdTimers: Record<string, ReturnType<typeof setTimeout>>
  notify(n: AgentNotice): void
}

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
        const created = new Set(inner.created)
        const timers = new Set(Object.keys(inner.holdTimers))
        const applied = method(...args) as Promise<unknown>
        const optimistic = inner.state
        // What this call changed: the state keys it replaced. Only those are taken back, so a write made in between stays.
        const changed = (Object.keys(optimistic) as (keyof AgentState)[]).filter(k => optimistic[k] !== before[k])
        const refused = applied.then(async () => {
          // The server said no: take this change back (not the whole state), save what is left, tell the listeners and the person.
          const now = inner.state
          const kept: Record<string, unknown> = { ...now }
          for (const k of changed) if (now[k] === optimistic[k]) kept[k] = before[k]
          // Nothing else changed meanwhile: the old state object itself comes back, so its identity does too.
          inner.state = now === optimistic ? before : (kept as unknown as AgentState)
          storage.set(MOCK_STORAGE_KEY, JSON.stringify(inner.state))
          for (const id of [...inner.created]) if (!created.has(id)) inner.created.delete(id)
          for (const id of Object.keys(inner.holdTimers)) if (!timers.has(id)) { clearTimeout(inner.holdTimers[id]); delete inner.holdTimers[id] }
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
  let mock: MockAgent = new Mock()
  const armed = new Map<string, AgentErrorCode>()
  let proxy = injecting(mock, armed)
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
      personId: 'person-1',
      photoDataUrl: 'data:image/png;base64,AAAA',
      teamRequest: { icon: 'build', title: 'Connect Klaviyo', sub: 'From Settings', status: 'Requested' },
      newChat: { id: 'contract-chat-1', title: 'A new chat' },
      paddedTitle: '  Padded   title  ',
      paddedTitleTrimmed: 'Padded title',
      unknownChatId: 'no-such-chat',
      unknownTraceId: 'no-such-trace',
    },
    failedSaveNotice: 'save.failed',
    capabilities: { agentWritesSaveInClient: true },
    async setup() { vi.useFakeTimers() },
    async teardown() { vi.useRealTimers() },
    async settle() { await vi.advanceTimersByTimeAsync(0) },
    async advance(ms) { await vi.advanceTimersByTimeAsync(ms) },
    async reset() {
      savesFail = false
      armed.clear()
      mock.reset()
      storage.clear()
      mock = new Mock()
      proxy = injecting(mock, armed)
    },
    async seed(state) { mock.setDemo(state) },
    async failSaves(on) { savesFail = on },
    async injectError(method, code) { if (code) armed.set(method, code); else armed.delete(method) },
  }
}

export const targets: ContractTarget[] = [mockTarget()]
