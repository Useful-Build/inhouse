// The BrandAgent's composition root (p3-design section 12): the real pool, files and usage ports, one anchor per owner.
// Each owner fills only its own anchor, in its own PR; nobody edits another's. W1's first PR typed each anchor with its
// port (ports.ts) and made it return the fake under testing/; each owner then returns its real port there.
import type { BrandAgentPorts, FileLedgerPort, RunnerPoolPort, UsageLedgerPort } from './ports.ts'
import { FakeFileLedger } from './testing/fake-files.ts'
import { FakeRunnerPool } from './testing/fake-pool.ts'
import { FakeUsageLedger } from './testing/fake-usage.ts'

/** The ports the BrandAgent runs on, built once per object from its env. */
export function composePorts(env: Env): BrandAgentPorts {
  return {
    pool: poolPort(env),

    files: filesPort(env),

    usage: usagePort(env),
  }
}

// ---------- W2's anchor (p3-w2.md): RunnerPoolPort ----------
function poolPort(_env: Env): RunnerPoolPort {
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
