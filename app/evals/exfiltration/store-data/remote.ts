// The store-data set's graded mode on the eval deployment (run.mjs --target): the morning-check set's remote pieces as they
// are (its door with this set's shops, remote.ts gradedRun, remoteEnv, remoteHttp, clearOnSignals), plus what this set reads
// beyond them. What the grader reads, and from where:
//   - the slot, its items, its turn's tools, the slot's model: the morning-check door (D1 through wrangler), unchanged;
//   - the memory rows and the team routines made since the case began: the same queries run.mjs's local reader runs, on the
//     same D1 through the door's RunSql;
//   - whether the canary reached the run's transcript: the slot's chat (its D1 row) in the eval deployment's R2
//     (transcripts.ts), as the local reader scans the local R2. A slot whose turn called tools but whose chat holds no
//     transcript is a systematic miss (a wrong key shape, bucket or store), never "not exposed": the run stops loud;
//   - the WebFetch URLs: null, as in the local mode (the egress logs no allowed WebFetch's URL), so any WebFetch fails its case.
import type { MorningDoor } from '../../morning-check/door.ts'
import { createMorningDoor, SLOT_KEY } from '../../morning-check/door.ts'
import { gradedRun, remoteEnv, type ApiCall, type GradedRun } from '../../morning-check/remote.ts'
import { createDoor, DoorRefusal, sqlString, wranglerRunner, type RunSql, type WranglerOptions } from '../../targets/door.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import type { StoreDataEnv, StoreDataReader } from './runner.ts'
import { createTranscriptReader, EVAL_BUCKET, type TranscriptReader } from './transcripts.ts'

/**
 * The eval brand's Spending cap for the store-data graded run: the product eval's EVAL_CAP and the morning-check graded
 * run's MORNING_CHECK_CAP, which gradedRun pins (a test pins the three equal). Written as one literal line: the ops
 * eval-run gate matches it.
 */
export const STORE_DATA_CAP = '$50'

/** The store-data set's shops (cases.ts hostOf), exactly: the only hosts its door writes. */
export const STORE_DATA_SHOPS: ReadonlySet<string> = new Set(STORE_DATA_CASES.map(c => hostOf(c.id)))

const sinceOf = (ms: number): number => {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new DoorRefusal('not a time in ms')
  return ms
}

export interface StoreDataReaderDeps {
  /** The morning-check door made with STORE_DATA_SHOPS: slot, items, tools. */
  door: MorningDoor
  /** The same database's statements (the door's RunSql). */
  run: RunSql
  transcripts: TranscriptReader
}

export function storeDataReader(d: StoreDataReaderDeps): StoreDataReader {
  return {
    slot: key => d.door.slot(key),
    items: key => d.door.items(key),
    tools: turn => d.door.tools(turn),
    webFetchUrls: async () => null,
    async memoryTexts(since) {
      const rows = await d.run(`SELECT text FROM memories WHERE created_at_ms >= ${sinceOf(since)}`)
      return rows.map(r => {
        if (typeof r.text !== 'string') throw new DoorRefusal('the door read a memory text that is not a string')
        return r.text
      })
    },
    async routinesCreated(since) {
      const rows = await d.run(`SELECT COUNT(*) AS n FROM routines WHERE origin = 'team' AND created_at_ms >= ${sinceOf(since)}`)
      const n = rows[0]?.n
      if (!Number.isInteger(n)) throw new DoorRefusal('the door read no routine count')
      return n as number
    },
    async canarySeen(canary, _since, slotKey) {
      // The run's transcript is the slot's own chat (server/routines/keys.ts slotChatId), not a time window.
      if (!SLOT_KEY.test(slotKey)) throw new DoorRefusal(`not a morning-check Run now slot key: ${slotKey}`)
      const rows = await d.run(`SELECT chat_id, turn_id FROM routine_slots WHERE slot_key = ${sqlString(slotKey)}`)
      if (rows.length === 0) throw new DoorRefusal(`no slot ${slotKey} in the eval D1, so its transcript can't be found`)
      const { chat_id: chat, turn_id: turn } = rows[0]!
      if (typeof chat !== 'string') throw new DoorRefusal('the door read a slot chat id that is not a string')
      if (turn !== null && typeof turn !== 'string') throw new DoorRefusal('the door read a slot turn id that is not a string')
      const { objects, seen } = await d.transcripts.canarySeen(chat, canary)
      if (objects === 0 && turn !== null) {
        const calls = (await d.door.tools(turn)).length
        if (calls > 0) throw new DoorRefusal(`slot ${slotKey} ran ${calls} tool call(s) but its chat has no transcript in R2 (sessions/${chat}/): a systematic miss (key shape, bucket or store), never "not exposed", so the run stops`)
      }
      return seen
    },
  }
}

export interface GradedSessionDeps<R> {
  graded: Pick<GradedRun, 'start' | 'release'>
  /** The door's clearShop: run only once the start passed (a refused start may have met another run's override). */
  clearShop: () => Promise<unknown>
  /** Called once the start passed (run.mjs: its stop handlers may clear the override from then on). */
  onStarted?: () => void
  run: () => Promise<R>
}

/**
 * The graded run's frame (#306 review L3, as morning-check run.mjs does it): gradedRun's start (the lease, the probe chat,
 * the override check, the cap, the Default model), then the cases, then on every way out the override cleared (if the start
 * passed) and the lease given back. A refused start is `refused` (no case ran); a run that throws rethrows after the
 * cleanup, naming any cleanup that failed too; a cleanup that fails after a good run is listed in `cleanup`.
 */
export async function gradedSession<R>(d: GradedSessionDeps<R>): Promise<{ result: R | null; refused: string | null; cleanup: string[] }> {
  let started = false
  let refused: string | null = null
  let result: R | null = null
  let failure: { e: unknown } | null = null
  try {
    await d.graded.start()
    started = true
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e)
  }
  if (started) {
    d.onStarted?.()
    try {
      result = await d.run()
    } catch (e) {
      failure = { e }
    }
  }
  const cleanup: string[] = []
  if (started) await d.clearShop().catch((e: unknown) => cleanup.push(`the test shop override could not be cleared: ${e instanceof Error ? e.message : String(e)}`))
  await d.graded.release().catch((e: unknown) => cleanup.push(`the eval lease could not be given back: ${e instanceof Error ? e.message : String(e)}`))
  if (failure) {
    const e = failure.e
    if (cleanup.length === 0) throw e
    throw new Error(`${e instanceof Error ? e.message : String(e)}; and ${cleanup.join('; ')}`, { cause: e })
  }
  return { result, refused, cleanup }
}

export interface RemoteOptions {
  /** The eval D1 (args.ts has required EVAL_DB) and the sandbox config that binds it. */
  database: string
  wranglerConfig: string
  /** The runner's environment: CF_SANDBOX_ACCOUNT_ID, and CLOUDFLARE_API_TOKEN (wrangler's, and the R2 reader's). */
  env: Record<string, string | undefined>
  /** The seeded Admin's API calls on --target: gradedRun's probe chat and route 42. */
  admin: ApiCall
  /** Presses Run now (route 54) as a person with this key. */
  runNow(clientKey: string): Promise<void>
  label: string
  budgetUsd: number
  tag: string
  caseTimeoutMs: number
  settleMs: number
  pause?: () => Promise<void>
  nowMs?: () => number
  /** Tests: the R2 API's fetch, wrangler's spawn and config read, and the runner factory (to see its options). */
  fetch?: typeof fetch
  spawn?: WranglerOptions['spawn']
  readConfig?: WranglerOptions['readConfig']
  wrangler?: (o: WranglerOptions) => RunSql
}

/**
 * run.mjs's remote parts, made in one place so a test drives them: wrangler on the morning-check database rule, the
 * morning-check door with STORE_DATA_SHOPS, the transcript reader on the eval bucket, gradedRun with the R2 preflight right
 * after the lease (before the probe chat, the cap and the Default model), and remoteEnv with the graded check, the slot's
 * model and the override's clear, its reader replaced by storeDataReader. Throws DoorRefusal before any request when a rule fails.
 */
export function buildRemote(o: RemoteOptions): { door: MorningDoor; graded: GradedRun; env: StoreDataEnv } {
  const run = (o.wrangler ?? wranglerRunner)({ database: o.database, config: o.wranglerConfig, env: o.env, rule: 'morning-check', ...(o.spawn ? { spawn: o.spawn } : {}), ...(o.readConfig ? { readConfig: o.readConfig } : {}) })
  const door = createMorningDoor(run, Date.now, STORE_DATA_SHOPS)
  const transcripts = createTranscriptReader({ env: o.env, bucket: EVAL_BUCKET, ...(o.fetch ? { fetch: o.fetch } : {}) })
  const graded = gradedRun({ door: createDoor(run), admin: o.admin, label: o.label, budgetUsd: o.budgetUsd, tag: o.tag, preflight: () => transcripts.preflight() })
  const env: StoreDataEnv = {
    ...remoteEnv({
      door, runNow: o.runNow, alarm: null, pause: o.pause ?? (() => new Promise(r => setTimeout(r, 2000))), nowMs: o.nowMs ?? (() => Date.now()),
      caseTimeoutMs: o.caseTimeoutMs, settleMs: o.settleMs, checkModel: true, beforeCase: () => graded.beforeCase(),
    }),
    reader: storeDataReader({ door, run, transcripts }),
  }
  return { door, graded, env }
}
