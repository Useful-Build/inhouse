// The test build's controls (P4 wave 4, p4-w6.md OC 2), Worker side. Import it only as `@test-controls`: `vite build
// --mode product-test` resolves that to this file, every other build to test-controls-off.ts, so this never enters the
// deployable Worker (scripts/check-product-build.mjs scans for the canary below and for this module). Reached only
// through route 67 (alarm-now.ts), inside `if (__INHOUSE_TEST_BUILD__ && env.INHOUSE_TEST_BUILD === '1')`: the
// generic alarm-now control, routine controls and job test controls. The off module has no test behavior.
import type { JobTimingName } from './job-timings.ts'
import { JOB_TIMING_NAMES } from './job-timings.ts'

/** The bundle-scan canary: it must be in the test build's Worker and never in the deployable one. */
export const TEST_CONTROLS_CANARY = 'inhouse-test-controls-canary-5d81e0a7'

/**
 * Runs one scheduler pass now (the BrandAgent's `alarm()` body), for specs that can't wait for the runtime's alarm.
 * It may overlap the runtime's own pass; the scheduler's handlers are idempotent by task id (BrandAgent.testRunAlarm).
 */
export async function runAlarmNow(pass: () => Promise<void>): Promise<{ ran: true }> {
  console.log({ event: 'test_control', control: 'alarm_now', canary: TEST_CONTROLS_CANARY })
  await pass()
  return { ran: true }
}

/**
 * The stop-after-batch switch. Module state, so it lives in the isolate of the BrandAgent that armed it, where the tick
 * runs (the brand has one object). One-shot: the next tick pass that reaches its hook clears it.
 */
let stopAfterBatch = false

/** Arms the switch: the next tick pass throws right after its decide batches commit (a crash between slot row and run). */
export function armStopAfterBatch(): { armed: true } {
  console.log({ event: 'test_control', control: 'stop_after_batch', canary: TEST_CONTROLS_CANARY })
  stopAfterBatch = true
  return { armed: true }
}

// Set via RPC on the BrandAgent so the reads and writes happen in the same isolate. Kept in the BrandAgent's own SQLite
// too (its `flags` table) and loaded back when the object is constructed (`loadTestControls`): an eviction or a
// hibernation between a spec's `setTimings` and the turn it times cleared the memory copy, so a 150 s `JOB_CUT_MS`
// became the 25-minute default and no job started (jobs.spec.ts on #454 and #455, 2026-11-27).
let timings = new Map<JobTimingName, number>()
/** The `flags` row that keeps the overrides (JSON), in the BrandAgent's SQLite. */
export const TIMINGS_FLAG = 'test:job_timings'

const validTimings = (o: Record<string, unknown>): [JobTimingName, number][] =>
  Object.entries(o).filter((e): e is [JobTimingName, number] =>
    (JOB_TIMING_NAMES as readonly string[]).includes(e[0]) && Number.isSafeInteger(e[1]) && (e[1] as number) > 0)

/**
 * Replaces the entire set, in memory and in the object's SQLite (`sql`, its `flags` table; the BrandAgent always passes
 * it). Pass an empty object in teardown to restore the defaults. Names: job-timings.ts.
 */
export function setTimings(overrides: Partial<Record<JobTimingName, number>>, sql?: SqlStorage): { set: true } {
  console.log({ event: 'test_control', control: 'set_timings', canary: TEST_CONTROLS_CANARY })
  timings = new Map(validTimings(overrides))
  // The BrandAgent always passes its SQLite; a unit test that runs no object keeps the overrides in memory only.
  sql?.exec('INSERT INTO flags (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', TIMINGS_FLAG, JSON.stringify(Object.fromEntries(timings)))
  return { set: true }
}

/** The BrandAgent's constructor: the overrides kept in its SQLite, back in memory (none kept: the defaults). */
export function loadTestControls(sql: SqlStorage): void {
  const row = sql.exec<{ value: string }>('SELECT value FROM flags WHERE key = ?', TIMINGS_FLAG).toArray()[0]
  timings = new Map(row ? validTimings(JSON.parse(String(row.value)) as Record<string, unknown>) : [])
}

/** The overrides in effect now, as the observe control reports them. */
export function currentTimings(): Partial<Record<JobTimingName, number>> {
  return Object.fromEntries(timings)
}

/**
 * This isolate's id, made on first use (a random value can't be made at a module's top level in Workers): the observe
 * control reports it, so a spec sees when the BrandAgent moved to a new isolate.
 */
let isolate: string | null = null
export function isolateId(): string {
  isolate ??= crypto.randomUUID()
  return isolate
}

export function timing(name: JobTimingName, fallback: number): number {
  return timings.get(name) ?? fallback
}

/** Hard kill, not a runner stop: the existing monitor detects the exit. Never starts a container. */
export async function killRunner(container: { readonly running: boolean; destroy(): Promise<void> } | undefined): Promise<{ killed: boolean }> {
  if (!container?.running) return { killed: false }
  console.log({ event: 'test_control', control: 'kill_runner', canary: TEST_CONTROLS_CANARY })
  await container.destroy()
  return { killed: true }
}

/** Restores the tests' fresh state (routines/test-kit.ts `fresh`). */
export function resetTestControls(): void {
  stopAfterBatch = false
  timings.clear()
}

/** The tick's hook, called after its decide step (routines/tick.ts). Throws once when armed, and clears the switch. */
export function afterTickBatch(): void {
  if (!stopAfterBatch) return
  stopAfterBatch = false
  console.log({ event: 'test_control', control: 'stopped_after_batch', canary: TEST_CONTROLS_CANARY })
  throw new Error('test control: the tick stopped after its batch')
}

/**
 * Sets one live routine's cursor to `checkedUntilMs` (the caller checks it's in the past), for the missed-run and
 * catch-up cases. `rev` is left alone: a pass that read the old cursor finds its gated update matches nothing and decides
 * again next pass (tick.ts `decideRoutine`). `{ seeded: false }` when no live routine has that id.
 */
export async function seedCursor(db: D1Database, routineId: string, checkedUntilMs: number): Promise<{ seeded: boolean }> {
  console.log({ event: 'test_control', control: 'seed_cursor', canary: TEST_CONTROLS_CANARY })
  const res = await db.prepare('UPDATE routines SET checked_until_ms = ? WHERE id = ? AND deleted_at_ms IS NULL')
    .bind(checkedUntilMs, routineId).run()
  return { seeded: res.meta.changes === 1 }
}
