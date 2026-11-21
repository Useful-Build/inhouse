// The connector list (orchestrator only). Each connector lives in its own directory, app/hub/connectors/<tool>/, and
// its route.ts exports one module. Adding a connector is one line here, added by the orchestrator, so connectors never
// edit the hub's entry (app/hub/index/). Workers bundles need static imports, which is why the list is a file and not
// a directory scan. H0's registry completeness test fails when a connectors/*/route.ts on disk isn't listed here.
import { slackConnector } from './mcp/slack/route'
import { shopifyConnector } from './shopify/route'

export const connectors = [shopifyConnector, slackConnector] as const
