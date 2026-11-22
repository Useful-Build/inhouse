// The morning-check set's door into a deployed build's D1 (the remote mode of run.mjs, and the scripted proof
// e2e/api/morning-check-remote.spec.ts): the same `RunSql` the eval harness's memory door uses (evals/targets/door.ts:
// `wrangler d1 execute --remote` on a per-PR sandbox database only, credentials from the environment, never logged).
// Two jobs, so the deployed build gains no HTTP surface:
//  - the test shop override: the `settings` row the test and eval builds' egress reads on each hub call
//    (server/egress/test-shop.ts). The door owns its lifecycle: set per case, cleared at case end and at run start
//    (runner.ts), each write read back, so no override outlives its case unseen;
//  - what the grader needs from a slot: the same rows and columns run.mjs's local reader takes from the local D1 file, so
//    runner.ts and grade.ts read them unchanged.
// Every value in a statement is checked against a pattern and quoted; nothing else reaches SQL.
// One runner per deployment: the override is one row per deployment (one brand, one D1), so two runs against the same build
// would set each other's shop. Never run two at once against one deployment.
import { TEST_SHOP_KEY, TEST_SHOP_OWNER } from '../../server/egress/test-shop.ts'
import { DoorRefusal, sqlString, type RunSql } from '../targets/door.ts'
import { META, hostOf } from './expected.ts'
import { ROUTINE_ID, type Reader, type SlotRow } from './runner.ts'

/** A Run now slot of the morning check (runner.ts: `now|<routine>|<32 hex>`), the only slots this door reads. */
const SLOT_KEY = new RegExp(`^now\\|${ROUTINE_ID}\\|[0-9a-f]{32}$`)
const TURN_ID = /^[A-Za-z0-9_.:|-]{1,128}$/
/** The set's own shops (expected.ts hostOf): the only hosts this door writes. */
const SHOPS = new Set(META.map(c => hostOf(c.id)))

export interface MorningDoor extends Reader {
  /** Sets the test shop override to one of the set's shops and reads it back. */
  setShop(host: string): Promise<void>
  /**
   * Stops the door setting any shop: every later setShop throws DoorRefusal before any SQL (the stop handlers call it
   * before their clear, so a run still going can't write an override after it). Clearing and reading still work.
   */
  close(): void
  /** Removes the override and reads back that none is left. Returns the host it removed (null: none was set). */
  clearShop(): Promise<string | null>
  /**
   * The API model id a slot's turn was submitted with (`submit_json.model`, fixed when the slot is made from the brand's
   * Default model: server/routines/brand.ts submitSettings), or null while the slot doesn't exist.
   */
  model(slotKey: string): Promise<string | null>
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new DoorRefusal(`the door read a ${what} that is not a string`)
  return v
}
const strOrNull = (v: unknown, what: string): string | null => (v === null ? null : str(v, what))

export function createMorningDoor(run: RunSql, nowMs: () => number = Date.now): MorningDoor {
  const where = `owner = ${sqlString(TEST_SHOP_OWNER)} AND key = ${sqlString(TEST_SHOP_KEY)}`
  const held = async (): Promise<unknown[]> => (await run(`SELECT value_json FROM settings WHERE ${where}`)).map(r => r.value_json)
  let closed = false
  return {
    close() {
      closed = true
    },
    async setShop(host) {
      // Checked in the same tick as the INSERT below starts (wrangler runs synchronously), so a close can't fall between.
      if (closed) throw new DoorRefusal('refusing: the door is closed (the run is stopping), so no shop is set')
      if (!SHOPS.has(host)) throw new DoorRefusal(`refusing: ${JSON.stringify(host)} is not one of the morning-check set's shops`)
      const value = JSON.stringify(host)
      const at = nowMs()
      await run(
        `INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (${sqlString(TEST_SHOP_OWNER)}, ${sqlString(TEST_SHOP_KEY)}, ${sqlString(value)}, 1, ${at}, 'eval', 'eval') ` +
          `ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms`,
      )
      const now = await held()
      if (now.length !== 1 || now[0] !== value) throw new DoorRefusal(`the test shop override reads back ${JSON.stringify(now)}, not ${value}`)
    },
    async clearShop() {
      const before = await held()
      await run(`DELETE FROM settings WHERE ${where}`)
      const now = await held()
      if (now.length !== 0) throw new DoorRefusal('the test shop override is still set after clearing it')
      if (before.length === 0) return null
      // The row holds the host as JSON; a row that isn't (someone else's write) is named as it was stored.
      const raw = String(before[0])
      try {
        const host: unknown = JSON.parse(raw)
        return typeof host === 'string' ? host : raw
      } catch {
        return raw
      }
    },
    async slot(slotKey) {
      if (!SLOT_KEY.test(slotKey)) throw new DoorRefusal(`not a morning-check Run now slot key: ${slotKey}`)
      const rows = await run(`SELECT slot_key, state, failure, result_text, turn_id, claimed_at_ms FROM routine_slots WHERE slot_key = ${sqlString(slotKey)}`)
      if (rows.length === 0) return null
      const r = rows[0]!
      const row: SlotRow = {
        slot_key: str(r.slot_key, 'slot key'), state: str(r.state, 'slot state'), failure: strOrNull(r.failure, 'failure'),
        result_text: strOrNull(r.result_text, 'result text'), turn_id: strOrNull(r.turn_id, 'turn id'), claimed_at_ms: Number(r.claimed_at_ms),
      }
      return row
    },
    async model(slotKey) {
      if (!SLOT_KEY.test(slotKey)) throw new DoorRefusal(`not a morning-check Run now slot key: ${slotKey}`)
      const rows = await run(`SELECT submit_json FROM routine_slots WHERE slot_key = ${sqlString(slotKey)}`)
      if (rows.length === 0) return null
      let model: unknown
      try {
        model = (JSON.parse(str(rows[0]!.submit_json, 'submit')) as { model?: unknown } | null)?.model
      } catch {
        throw new DoorRefusal('the door read a slot submit that is not JSON')
      }
      return str(model, 'slot model')
    },
    async items(slotKey) {
      if (!SLOT_KEY.test(slotKey)) throw new DoorRefusal(`not a morning-check Run now slot key: ${slotKey}`)
      return (await run(`SELECT item_json FROM today_items WHERE slot_key = ${sqlString(slotKey)} ORDER BY rowid`)).map(r => str(r.item_json, 'item'))
    },
    async tools(turnId) {
      if (!TURN_ID.test(turnId)) throw new DoorRefusal('not a turn id')
      return (await run(`SELECT tool FROM tool_calls WHERE turn_id = ${sqlString(turnId)} ORDER BY n`)).map(r => str(r.tool, 'tool name'))
    },
  }
}
