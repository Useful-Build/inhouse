// The BrandAgent's composition root (p3-design section 12): the real pool, files and usage ports, one anchor per owner.
// Each owner fills only its own anchor, in its own PR; nobody edits another's. W1's first PR typed each anchor with its
// port (ports.ts) and made it return the fake under testing/; each owner then returns its real port there. The pool
// lives in the BrandAgent, so its anchor also gets the object's parts (its SQLite, scheduler, clock and placement hooks).
import type { BrandAgentParts, BrandAgentPorts, FileLedgerPort, RunnerPoolPort, UsageLedgerPort } from './ports.ts'
import { FakeFileLedger } from './testing/fake-files.ts'
import { FakeRunnerPool } from './testing/fake-pool.ts'
import { FakeUsageLedger } from './testing/fake-usage.ts'

/** The ports the BrandAgent runs on, built once per object from its env. */
export function composePorts(env: Env, parts: BrandAgentParts): BrandAgentPorts {
  return {
    pool: poolPort(env, parts),

    files: filesPort(env),

    usage: usagePort(env),
  }
}

// ---------- W2's anchor (p3-w2.md): RunnerPoolPort ----------
function poolPort(_env: Env, _parts: BrandAgentParts): RunnerPoolPort {
  return new FakeRunnerPool()
}

// ---------- W3's anchor (p3-w3.md): FileLedgerPort ----------
function filesPort(_env: Env): FileLedgerPort {
  return new FakeFileLedger()
}

// ---------- W4's anchor (p3-w4.md): UsageLedgerPort ----------
function usagePort(_env: Env): UsageLedgerPort {
  return new FakeUsageLedger()
}
