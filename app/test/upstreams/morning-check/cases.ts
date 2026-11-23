// The graded cases joined to their datasets (each a function of `now`, ./datasets.ts). Bundled into the hub's test build
// through ./upstreams.ts, so no npm imports.
import type { Dataset } from '../shopify/dataset'
import * as d from './datasets'
import { META } from '../../../evals/morning-check/expected'
import type { MorningCaseMeta } from '../../../evals/morning-check/expected'

export interface MorningCase extends MorningCaseMeta {
  build(nowMs: number): Dataset
}

const BUILDERS = d as unknown as Record<string, (nowMs: number) => Dataset>

export const CASES: readonly MorningCase[] = META.map(m => {
  const build = BUILDERS[m.builder]
  if (!Object.hasOwn(BUILDERS, m.builder) || typeof build !== 'function') throw new Error(`morning-check: no dataset function ${m.builder}`)
  return { ...m, build }
})

export const caseById = (id: string): MorningCase => {
  const c = CASES.find(x => x.id === id)
  if (!c) throw new Error(`morning-check: no case ${id}`)
  return c
}
