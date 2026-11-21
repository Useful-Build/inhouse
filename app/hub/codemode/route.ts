// Code mode for Shopify (P5 W2): one read tool, shopify_script_run. The module shares `id: 'shopify'` and the Shopify
// account and scope lists with the Shopify connector, so readiness, pause and configuration are the account's: pausing
// Shopify hides and refuses this tool with the six, and an unconfigured Shopify lists neither. The orchestrator adds
// `codeModeConnector` to connectors/index.ts beside `shopifyConnector`.
//
// The model's code runs in a Dynamic Worker with no network (run.ts); its one reach is `shop.graphql`, which goes
// through the Shopify SignIn exactly as the six tools do: the read-only check and the level 1 allowlist (scope/fields.ts)
// run there before a token is opened. Raw pages never leave the hub; only the script's small return value does.
// A script failure is a successful tool result carrying the script's own error text (the model needs it to fix its
// code); a cap is a rate_limited error with its fixed message.
import { z } from 'zod'
import type { ConnectorModule, ToolContext, ToolDef } from '../registry/registry'
import { err, ok } from '../index/errors'
import { log } from '../index/log'
import { shopifyConnector } from '../connectors/shopify/route'
import { SHOPIFY_API_VERSION } from '../connectors/shopify/documents'
import { ScriptApi } from './api'
import { DAY_CAP, DAY_CAP_MESSAGE, MAX_CALLS, RUN_CAP, RUN_CAP_MESSAGE, RUN_CAP_TTL_MS } from './caps'
import { codeHashForLog, scriptId } from './script'

export const CODEMODE_ACCOUNT = shopifyConnector.accountId
export const MAX_CODE_CHARS = 20_000

const DESCRIPTION =
  'Run a short JavaScript function body over many Shopify orders or products, when the bounded tools would need many ' +
  'pages: counts, totals, rankings, "which of all". Not for one order, one product or a short list: use the other ' +
  'Shopify tools. API: `declare const shop: { graphql(query: string, variables?: Record<string, unknown>): Promise<{ ' +
  'data: any }> }`, read-only Admin GraphQL `2026-10`. Only the fields, filters (`query` keys) and sort keys the ' +
  'Shopify tools use are allowed, others are refused; no free-text search on orders; at most 3 root fields. Use ' +
  '`nodes`, not `edges`; `first` at most 250, page with `pageInfo.endCursor`. At most ' +
  `${MAX_CALLS} calls per script, one at a time. \`return\` a small JSON value (at most 8 KB): counts, ids and the ` +
  'few fields the answer needs, never the raw pages. No `fetch`, no network. Order filters: financial_status, ' +
  "fulfillment_status, return_status, sku, name, processed_at:>='<ISO>'; products: status, sku, inventory_total:<n."

const Input = z.strictObject({ code: z.string().min(1).max(MAX_CODE_CHARS) })

/** The next UTC midnight after `nowMs`, and the day's key. */
export function utcDay(nowMs: number): { key: string; endsAtMs: number } {
  const d = new Date(nowMs)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return { key: new Date(start).toISOString().slice(0, 10), endsAtMs: start + 24 * 60 * 60_000 }
}

/** `run:<runId>` for the runner, `job:<job>` for product server code: never a key another scope can hit. */
export const runKey = (scope: ToolContext['scope']): string => (scope.kind === 'run' ? `run:${scope.runId}` : `job:${scope.job}`)

export const shopifyScriptRun: ToolDef<z.infer<typeof Input>> = {
  name: 'shopify_script_run',
  description: DESCRIPTION,
  mode: 'read',
  input: Input,
  async run(ctx, { code }) {
    const codemode = ctx.codemode
    if (!codemode) return err('not_configured', 'shopify')
    const codeHash = codeHashForLog(await scriptId(code))
    const quiet = { codeHash, calls: 0, bytes: 0, ms: 0 }

    // The run's cap first: a call the day refuses still counts toward its run, which can't matter once the day is out.
    const perRun = await codemode.bumpCounter(runKey(ctx.scope), RUN_CAP, RUN_CAP_TTL_MS)
    if (!perRun.ok) return perRun
    if (!perRun.value.ok) {
      log('hub_codemode', { ...quiet, outcome: 'run_cap' })
      return err('rate_limited', RUN_CAP_MESSAGE)
    }
    const day = utcDay(ctx.nowMs)
    const ttl = day.endsAtMs - ctx.nowMs
    const perDay = await codemode.bumpCounter(`day:${day.key}`, DAY_CAP, ttl)
    if (!perDay.ok) return perDay
    if (!perDay.value.ok) {
      log('hub_codemode', { ...quiet, outcome: 'daily_cap' })
      return err('rate_limited', DAY_CAP_MESSAGE, ttl)
    }

    const out = await codemode.run(code, new ScriptApi(ctx.shopify, SHOPIFY_API_VERSION))
    log('hub_codemode', { codeHash, calls: out.calls, bytes: out.bytes, outcome: out.outcome, ms: out.ms })
    return out.outcome === 'ok'
      ? ok({ result: out.result, calls: out.calls, ms: out.ms })
      : ok({ error: out.error, calls: out.calls, ms: out.ms })
  },
}

export const codeModeConnector: ConnectorModule = {
  id: shopifyConnector.id,
  accountId: shopifyConnector.accountId,
  apiVersion: shopifyConnector.apiVersion,
  scopes: shopifyConnector.scopes,
  tools: [shopifyScriptRun],
}
