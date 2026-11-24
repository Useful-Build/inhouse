// The Tools page's catalog (P5 W3): what each connector the hub can host is called and what it does, keyed by connector
// id. Copy only, no brand data. `listTools` (tools.ts) never invents a tool: a connector listed here shows only when the
// hub returns its account and says it's configured.
import type { StageIndex } from '../../shared/contract/common.ts'

export interface CatalogEntry {
  /** The connector id: the key the client speaks (`connectTool('slack')`, `/tools/slack`). */
  key: string
  /** The hub's account id for it (the client never builds one). */
  accountId: string
  name: string
  desc: string
  site: string
  /** The stage the tool starts at. */
  need: StageIndex
  /** OAuth connectors can be disconnected here. Shopify's credentials are the deployment's config. */
  oauth: boolean
  ex: string[]
  read: string
  draft: string
  run: string
  conn: string
}

/** In display order. */
export const TOOL_CATALOG: readonly CatalogEntry[] = [
  {
    key: 'shopify', accountId: 'shopify:store', name: 'Shopify', desc: 'Orders, products, inventory and customers', site: 'shopify.com', need: 0, oauth: false,
    ex: ['Which products will run out before Black Friday?', 'Show me orders stuck over 3 days.', "What were last week's best sellers?"],
    read: 'Orders, products, inventory, customers and discounts',
    draft: 'Pause a variant, restock returns, update stock counts',
    run: 'Restock returns and pause oversold variants, within your limits',
    conn: 'Custom app on your Shopify store, built by the Inhouse team',
  },
  {
    key: 'slack', accountId: 'slack:workspace', name: 'Slack', desc: 'Team conversations in the channels your agent can see', site: 'slack.com', need: 0, oauth: true,
    ex: ['What did the team say about the supplier delay this week?', 'Find the thread where we picked the new courier.', 'Who has talked about the returns backlog?'],
    read: 'Messages in public channels, channel names and the people in them',
    draft: 'Nothing. Slack is read only for the agent.',
    run: 'Nothing. Notices reach the team through the channels your admin lists.',
    conn: 'An app in your Slack workspace, signed in by the Inhouse team',
  },
]

const byKey = new Map(TOOL_CATALOG.map(e => [e.key, e] as const))
const byAccount = new Map(TOOL_CATALOG.map(e => [e.accountId, e] as const))

export const catalogByKey = (key: string): CatalogEntry | undefined => byKey.get(key)
export const catalogByAccount = (accountId: string): CatalogEntry | undefined => byAccount.get(accountId)
