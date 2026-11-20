// The contract suite's real targets: the real client (src/agent/http/) against the test build under `wrangler dev` at
// `origin`. targets.ts appends these when CONTRACT_REAL_ORIGIN is set. W4 fills this in P2 (one file per resource
// group beside this one); from P3 this file is the orchestrator's.
import type { ContractTarget } from '../../targets'

export function realTargets(_origin: string): ContractTarget[] {
  return []
}
