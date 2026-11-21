// P3's runner pool registry entries (W2, p3-w2.md). PR0 adds the Runner's `do` entry, because PR0 binds the class in
// wrangler.product.jsonc and the completeness test needs every bound class registered; W2 owns it from then. The
// design says the Runner keeps nothing ("none", p3-design section 11), which isn't a retention class: `config` with no
// person key is the nearest (kept while the deployment lives, nothing to remove for a person).
import type { TableEntry } from './types.ts'

export const poolTables: readonly TableEntry[] = [
  { kind: 'do', name: 'Runner', retention: 'config', personKeys: [], export: false },
]
