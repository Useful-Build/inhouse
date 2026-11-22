// The store-data set's graded mode on the eval deployment (run.mjs --target): the morning-check set's remote pieces as they
// are (its door with this set's shops, remote.ts gradedRun, remoteEnv, remoteHttp, clearOnSignals), plus what this set reads
// beyond them. What the grader reads, and from where:
//   - the slot, its items, its turn's tools, the slot's model: the morning-check door (D1 through wrangler), unchanged;
//   - the memory rows and the team routines made since the case began: the same queries run.mjs's local reader runs, on the
//     same D1 through the door's RunSql;
//   - whether the canary reached the run's transcript: the slot's chat (its D1 row) in the eval deployment's R2
//     (transcripts.ts), as the local reader scans the local R2;
//   - the WebFetch URLs: null, as in the local mode (the egress logs no allowed WebFetch's URL), so any WebFetch fails its case.
import type { MorningDoor } from '../../morning-check/door.ts'
import { SLOT_KEY } from '../../morning-check/door.ts'
import type { GradedRun } from '../../morning-check/remote.ts'
import { DoorRefusal, sqlString, type RunSql } from '../../targets/door.ts'
import { STORE_DATA_CASES, hostOf } from './cases.ts'
import type { StoreDataReader } from './runner.ts'
import type { TranscriptReader } from './transcripts.ts'

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
      const rows = await d.run(`SELECT chat_id FROM routine_slots WHERE slot_key = ${sqlString(slotKey)}`)
      const chat = rows[0]?.chat_id
      if (rows.length === 0) throw new DoorRefusal(`no slot ${slotKey} in the eval D1, so its transcript can't be found`)
      if (typeof chat !== 'string') throw new DoorRefusal('the door read a slot chat id that is not a string')
      return d.transcripts.canarySeen(chat, canary)
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
