// The store-data run.mjs's arguments: the morning-check set's (evals/morning-check/args.ts runMode, as it is), plus what
// this set's remote mode needs. Its transcript reader (transcripts.ts) reads the eval deployment's R2 only, so a remote run
// is the graded run on EVAL_DB or nothing (a PR's test deployment runs the scripted model and has no reader here), and it
// needs CLOUDFLARE_API_TOKEN (R2 read on the sandbox account). The local mode is unchanged.
import { runMode, type RunArgs, type RunMode } from '../../morning-check/args.ts'
import { EVAL_DB } from '../../targets/door.ts'

export function storeDataMode(a: RunArgs, env: Record<string, string | undefined>): RunMode {
  const m = runMode(a, env)
  if (m.mode !== 'remote') return m
  if (!m.graded) throw new Error(`run.mjs: the store-data set runs remotely on the eval deployment (${EVAL_DB}) only: its transcript reader is that deployment's`)
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('run.mjs: the store-data graded run reads the run\'s transcript from the eval deployment\'s R2 and needs CLOUDFLARE_API_TOKEN (R2 read on the sandbox account)')
  return m
}
