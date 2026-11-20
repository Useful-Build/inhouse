// The health route's signal registry (P2 plan, "The health route"). Each phase adds its own signals here; P3's owners
// fill their own files (PR0 lists them).
import { coreSignals } from './core.ts'
import { poolSignals } from './pool.ts'
import { runsSignals } from './runs.ts'
import type { Signal } from './types.ts'

export const signals: readonly Signal[] = [...coreSignals, ...runsSignals, ...poolSignals]
