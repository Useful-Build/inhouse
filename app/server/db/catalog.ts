// The ids a technical setting key may name (`tm:<model>:effort`, `tm:<model>:on`, `l:<job>`) until a later phase
// serves them from the agent's own catalog (models: P3; run-limit jobs: P7). Copied from the demo's catalog
// (src/agent/sample-data/models.json and people-and-rules.json `runLimits.jobsAgentMayFinish`).
export const KNOWN_MODEL_IDS: readonly string[] = ['fable', 'opus', 'sonnet', 'haiku']
export const KNOWN_JOB_IDS: readonly string[] = ['returns', 'chase', 'nudge', 'pause']

/** Null when the key names no id or a known one; else what it names that isn't known. */
export function unknownIdIn(key: string): string | null {
  const model = /^tm:([^:]+):(effort|on)$/.exec(key)
  if (model) return KNOWN_MODEL_IDS.includes(model[1]) ? null : model[1]
  const job = /^l:([^:]+)$/.exec(key)
  if (job && key !== 'l:daily' && key !== 'l:restock') return KNOWN_JOB_IDS.includes(job[1]) ? null : job[1]
  return null
}
