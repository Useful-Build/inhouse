// The BrandAgent's composition root (p3-design section 12): the real pool, files and usage ports, one anchor per owner.
// Each owner fills only its own anchor, in its own PR; nobody edits another's. PR0 lays out the anchors before the ports
// exist: W1's first PR (ports.ts and the fakes under testing/) types each anchor with its port and makes it return the
// fake, and each owner then returns its real port there.

/** The ports the BrandAgent runs on, built once per object from its env. */
export function composePorts(env: Env) {
  return {
    pool: poolPort(env),

    files: filesPort(env),

    usage: usagePort(env),
  }
}

// ---------- W2's anchor (p3-w2.md): RunnerPoolPort ----------
function poolPort(_env: Env): unknown {
  return null
}

// ---------- W3's anchor (p3-w3.md): FileLedgerPort ----------
function filesPort(_env: Env): unknown {
  return null
}

// ---------- W4's anchor (p3-w4.md): UsageLedgerPort ----------
function usagePort(_env: Env): unknown {
  return null
}
