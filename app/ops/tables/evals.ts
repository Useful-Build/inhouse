// Stage 1 M3-R's stores (N30): the eval write log and its faults, written and read only on the eval deployment (its
// hub's EvalWriteGateway and the harness's door). Every other deployment holds them empty. No member id: a write request
// carries none. Configuration-like test state, cleared by the door per case-repeat; never exported.
import type { TableEntry } from './types.ts'

export const evalTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'eval_write_log', retention: 'config', personKeys: [], export: false },
  { kind: 'd1', name: 'eval_write_fault', retention: 'config', personKeys: [], export: false },
  // Stage 1 M3 (N31): the eval deployment's fake Slack workspace, its channels and planted messages (invented text, no
  // member id), written by the harness's door and read by the eval hub's fake Slack. Cleared per case-repeat.
  { kind: 'd1', name: 'eval_slack_channel', retention: 'config', personKeys: [], export: false },
  { kind: 'd1', name: 'eval_slack_message', retention: 'config', personKeys: [], export: false },
]
