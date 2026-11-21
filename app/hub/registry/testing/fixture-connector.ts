// A fixture connector for tests only. Never in connectors/index.ts. The test build loads it inside the guarded branch
// in signin/signin.ts; the bundle scan refuses any testing/ folder in the deployable bundle. Invented names only.
import { z } from 'zod'
import type { ConnectorModule, ToolDef } from '../registry'

export const FIXTURE_ACCOUNT = 'shopify:fixture'
export const FIXTURE_API_VERSION = '2026-10'

const shopRead: ToolDef<Record<string, never>> = {
  name: 'fixture_read',
  description: 'Fixture: reads the shop name.',
  mode: 'read',
  input: z.strictObject({}),
  run: (ctx) => ctx.shopify.graphql('query FixtureShop { shop { currencyCode } }'),
}

/** Sends the document it's given, so tests can prove the SignIn document check refuses a mutation. */
const queryRun: ToolDef<{ document: string }> = {
  name: 'fixture_query',
  description: 'Fixture: sends a GraphQL document as given.',
  mode: 'read',
  input: z.strictObject({ document: z.string() }),
  run: (ctx, input) => ctx.shopify.graphql(input.document),
}

export const fixtureConnector: ConnectorModule = {
  id: 'shopify',
  accountId: FIXTURE_ACCOUNT,
  apiVersion: FIXTURE_API_VERSION,
  scopes: { read: ['read_orders', 'read_products', 'read_returns'], required: ['read_returns'] },
  tools: [shopRead, queryRun],
}
