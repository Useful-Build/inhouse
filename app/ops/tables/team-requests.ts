// P6a W3's registry entry: requests to the Inhouse team (0470_team_requests.sql). `requested_by` is a person key; the
// table is the brand's own record of what it asked, kept while the brand is (config), exported with the brand's data.
import type { TableEntry } from './types.ts'

export const teamRequestTables: readonly TableEntry[] = [
  { kind: 'd1', name: 'team_requests', retention: 'config', personKeys: ['requested_by'], export: true },
]
