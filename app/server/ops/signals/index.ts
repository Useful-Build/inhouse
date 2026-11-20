// The health route's signal registry (P2 plan, "The health route"). Each phase adds its own signals here.
import { coreSignals } from './core.ts'
import type { Signal } from './types.ts'

export const signals: readonly Signal[] = [...coreSignals]
