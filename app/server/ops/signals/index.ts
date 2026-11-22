// The health route's signal registry (P2 plan, "The health route"). Each phase adds its own signals here; P3's owners
// fill their own files (PR0 lists them).
import { coreSignals } from './core.ts'
import { POOL_SIGNALS } from './pool.ts'
import { RUNS_SIGNALS } from './runs.ts'
import { usageSignals } from '../../usage/signal.ts'
import { routinesSignals } from '../../routines/signal.ts'
import type { Signal } from './types.ts'

export const signals: readonly Signal[] = [...coreSignals, ...RUNS_SIGNALS, ...POOL_SIGNALS, ...usageSignals, ...routinesSignals]
