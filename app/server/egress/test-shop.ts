// The test shop override, product side (P4, the morning-check set run remotely): the test and eval builds read the shop
// host a case sets in their own D1 (a `settings` row the eval harness's door writes and clears, evals/morning-check/door.ts)
// and pass it on each hub read call as `testShopHost` (hub/index/contract.ts CallToolOptions). Import it only as
// `@test-shop`: `vite build --mode product-test` and `--mode product-eval` resolve that to this file, every other build to
// test-shop-off.ts, so neither this module nor the option's name enters the deployable Worker (check-product-build.mjs
// scans for the canary, the name and this module). At runtime it reads nothing unless INHOUSE_TEST_BUILD is "1".
// Fail closed: a row this can't read as a shop host throws, so the egress answers the call as a binding failure, never as a
// read of the hub's own SHOPIFY_SHOP.
import type { AccountSummary, CallToolOptions, CallerScope, HubResult, ReadGateway } from '../../hub/index/contract.ts'

/** The hub's two read methods (hub.ts ReadGatewayLike, written out so the eval harness can import this file without the egress). */
type ReadGatewayLike = Pick<ReadGateway, 'listTools' | 'callTool'>
/** The one D1 call this makes (structural, so the node side, evals/morning-check/, typechecks it without the Worker's types). */
export type ShopDb = { prepare(sql: string): { bind(...values: string[]): { first<T>(): Promise<T | null> } } }

/** The bundle-scan canary: it must be in the test and eval builds' Worker and never in the deployable one. */
export const TEST_SHOP_CANARY: string = 'inhouse-test-shop-canary-9c4e17b2'

/** The row the door writes: an owner no person or the brand ever is, so no settings route lists or writes it. */
export const TEST_SHOP_OWNER: string = 'test-control'
export const TEST_SHOP_KEY: string = 'hub:shop'

/** A Shopify host, as the hub's CallToolOptionsSchema takes it (hub/index/schemas.ts SHOP_HOST). */
export const SHOP_HOST = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/

/** The override the door set, or null when none is set. Throws on a row that isn't a shop host. */
export async function readTestShop(db: ShopDb): Promise<string | null> {
  const row = await db.prepare('SELECT value_json FROM settings WHERE owner = ? AND key = ?').bind(TEST_SHOP_OWNER, TEST_SHOP_KEY).first<{ value_json: string }>()
  if (row === null) return null
  let host: unknown
  try {
    host = JSON.parse(row.value_json)
  } catch {
    throw new Error('test shop: the override row is not JSON')
  }
  if (typeof host !== 'string' || !SHOP_HOST.test(host)) throw new Error('test shop: the override row is not a shop host')
  return host
}

/** The hub as the egress calls it: each read call carries the override when one is set (a fresh read per call). */
export function withTestShop(hub: ReadGatewayLike, db: ShopDb, env: { INHOUSE_TEST_BUILD?: string }): ReadGatewayLike {
  if (env.INHOUSE_TEST_BUILD !== '1') return hub
  return {
    listTools: scope => hub.listTools(scope),
    async callTool(scope, name, args) {
      const host = await readTestShop(db)
      if (host === null) return hub.callTool(scope, name, args)
      const options: CallToolOptions = { testShopHost: host }
      console.log({ event: 'test_control', control: 'test_shop', canary: TEST_SHOP_CANARY })
      return hub.callTool(scope, name, args, options)
    },
  }
}

/**
 * The prompt's account read (ConnectGateway.listAccounts), written out structurally: the egress's import boundary keeps
 * ConnectGateway's type out of this folder, and only the prompt (server/prompt/connected.ts) wraps one.
 */
type ConnectAccountsLike = { listAccounts(scope: CallerScope, options?: CallToolOptions): Promise<HubResult<AccountSummary[]>> }

/**
 * P5 #337: the turn prompt's account read carries the same override as the reads (a fresh read per call), so the
 * "Connected apps" line names the account the turn's reads will use (the hub answers a Shopify row from the test shop's
 * own SignIn object). The gateway as it is unless the build is switched on. The wrapper's read takes the scope alone: a
 * caller's own options are not forwarded (no caller sends any; the override is the only option it sends).
 */
export function withTestShopConnect(gateway: ConnectAccountsLike, db: ShopDb, env: { INHOUSE_TEST_BUILD?: string }): ConnectAccountsLike {
  if (env.INHOUSE_TEST_BUILD !== '1') return gateway
  return {
    async listAccounts(scope) {
      const host = await readTestShop(db)
      if (host === null) return gateway.listAccounts(scope)
      const options: CallToolOptions = { testShopHost: host }
      return gateway.listAccounts(scope, options)
    },
  }
}

/**
 * withTestShopConnect for a request handler (route 70, server/api/tools.ts toolsDepsOf), whose env has no `DB` (D1
 * only through stores): the D1 binding comes from the Worker's own env here, in this test-and-eval-only module, never in
 * the handler that every build bundles (as server/ops/test-fakes.ts runTestFakesInWorker does). The gateway as it is
 * unless the build is switched on.
 */
export function withTestShopConnectInWorker(gateway: ConnectAccountsLike, env: { INHOUSE_TEST_BUILD?: string }): ConnectAccountsLike {
  if (env.INHOUSE_TEST_BUILD !== '1') return gateway
  return {
    async listAccounts(scope) {
      // Typed by hand: the eval harness's node project also compiles this file and has no Workers types (the specifier is a
      // plain literal once compiled, so the Worker build resolves it as ever).
      const { env: worker } = (await import('cloudflare:workers' as string)) as { env: { DB: ShopDb } }
      return withTestShopConnect(gateway, worker.DB, env).listAccounts(scope)
    },
  }
}

