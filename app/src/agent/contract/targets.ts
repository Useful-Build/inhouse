// The clients the contract suite runs against. Each target is `{ client, reset(), seed(state) }`; the suite never reaches
// past that, so the real client (P2, under `wrangler dev`) joins this list without changing a test.
import type { AgentClient, DemoContext } from '../types'
import type { MockAgent } from '../mock'

export interface ContractTarget {
  name: string
  /** The client in use now. `reset()` replaces it, so read it fresh in each test. */
  readonly client: AgentClient
  /** Back to a first-run state: no writes, no saved runs, no pending holds. */
  reset(): void
  /** Put the client in a stage and scenario (the demo's dev switcher). */
  seed(state: DemoContext): void
  /** Make every save fail (true) or work again (false): the forced failure the rollback tests need. */
  failSaves(on: boolean): void
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

function mockTarget(): ContractTarget {
  let mock: MockAgent = new Mock()
  return {
    name: 'mock',
    get client() { return mock },
    reset() {
      mock.reset()
      savesFail = false
      storage.clear()
      mock = new Mock()
    },
    seed: state => mock.setDemo(state),
    failSaves: on => { savesFail = on },
  }
}

export const targets: ContractTarget[] = [mockTarget()]
