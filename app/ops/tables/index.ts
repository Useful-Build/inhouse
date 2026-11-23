// The table registry (P2 plan, "The table registry"): every D1 table, Durable Object store and R2 prefix with its
// retention class, person key and export flag. Orchestrator only. W2's first PR adds the entry type (tables/types.ts),
// P2's entries (tables/core.ts) and the completeness test; the orchestrator lists them here. P3's owners fill their
// own files (PR0 lists them all).
import { activityTables } from './activity.ts'
import { chatTables } from './chat.ts'
import { coreTables } from './core.ts'
import { egressTables } from './egress.ts'
import { filesTables } from './files.ts'
import { hubTables } from './hub.ts'
import { libraryTables } from './library.ts'
import { memoryTables } from './memory.ts'
import { noticeTables } from './notices.ts'
import { p8Tables } from './p8.ts'
import { poolTables } from './pool.ts'
import { privacyTables } from './privacy.ts'
import { routineTables } from './routines.ts'
import { todayTables } from './today.ts'
import type { TableEntry } from './types.ts'
import { usageTables } from './usage.ts'

export const tables: readonly TableEntry[] = [...coreTables, ...chatTables, ...filesTables, ...usageTables, ...memoryTables, ...poolTables, ...activityTables, ...noticeTables, ...routineTables, ...libraryTables, ...todayTables, ...p8Tables, ...egressTables, ...hubTables, ...privacyTables]
