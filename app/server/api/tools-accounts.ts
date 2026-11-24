// The D1 side of the Tools routes (P5 W3): `ToolsAccounts` over W1's connector-account store. Reads map the rows to what
// the page uses; a pause writes its audit line, and a disconnect is the store's one batch (the row's change, `rev + 1`,
// and the line, the line guarded on the row this write stamped), so the line lands exactly when the change did.
import type { ConnectorAccountStore } from '../db/connector-accounts.ts'
import type { ToolsAccounts } from './tools.ts'

export function toolsAccounts(store: ConnectorAccountStore): ToolsAccounts {
  return {
    async list() {
      return (await store.list()).map(r => ({
        accountId: r.accountId, connector: r.connector, lastState: r.lastState, lastStateAtMs: r.lastStateAtMs, connectedBy: r.connectedBy, connectedAtMs: r.connectedAtMs,
      }))
    },
    recordPause: (at, accountId, line) => store.recordPause(accountId, line, at),
    recordDisconnect: (at, accountId, connector, line) => store.recordDisconnect(accountId, connector, line, at),
  }
}
