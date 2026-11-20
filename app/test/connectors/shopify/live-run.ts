// The live connector check (brief section 8): every case against the real read fixture store, through the tools' own
// `run` on H0's grant, scope check, document check and read call. The nightly runs it (live.live.ts); a node test
// runs it against the recorded upstream to prove it never prints a token, secret, body or header.
// It prints case names and fixed outcome texts only.
import { RESULT_FIELDS } from '../../../hub/connectors/shopify/fields'
import { SHOPIFY_API_VERSION } from '../../../hub/connectors/shopify/documents'
import { shopifyConnector } from '../../../hub/connectors/shopify/route'
import { RESULT_BUDGET_BYTES } from '../../../hub/connectors/shopify/shape'
import { parseShopifyConfig, type Upstream } from '../../../hub/signin/providers/shopify'
import { checkDataset } from '../../upstreams/shopify/dataset'
import { createShopifyUpstream, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from '../../upstreams/shopify/server'
import { casesFor, windowSource, type LiveCase } from './cases'
import { hubReadClient } from './client'
import { firstDifference, normalise, runCase } from './run'

export const LIVE_ENV = ['SHOPIFY_SHOP', 'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET'] as const

function keyPaths(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keyPaths(x, prefix, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) keyPaths(x, prefix ? `${prefix}.${k}` : k, out)
  else out.add(prefix)
  return out
}

export async function runLive(
  env: Record<string, string | undefined>,
  deps: { upstream: Upstream; committed: unknown; cases?: readonly LiveCase[]; print?: (line: string) => void },
): Promise<{ failures: string[] }> {
  const missing = LIVE_ENV.filter(k => !env[k])
  if (missing.length) throw new Error(`live: ${missing.join(', ')} must be set (the check fails, never skips)`)
  const config = parseShopifyConfig(env)
  if (!config) throw new Error('live: the Shopify settings are invalid')
  const print = deps.print ?? (line => console.log(line))
  const committed = checkDataset(deps.committed)
  // The fixed cases plus the window cases cut from the recording's own dates.
  const cases = deps.cases ?? casesFor(windowSource(committed))
  const failures: string[] = []
  const fail = (line: string) => {
    failures.push(line)
    print(line)
  }

  const client = hubReadClient(deps.upstream, config, shopifyConnector.scopes, SHOPIFY_API_VERSION)
  const granted = await client.grant()
  if (!granted.ok) {
    fail(`grant: ${granted.error.code}`)
    return { failures }
  }
  print('grant: ok, scopes match')

  const recorded = hubReadClient(
    createShopifyUpstream(committed),
    { shop: 'example-fixture', clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET },
    shopifyConnector.scopes,
    SHOPIFY_API_VERSION,
  )

  for (const c of cases) {
    const live = await runCase(c, client)
    if (!live.ok) {
      fail(`case ${c.name}: call failed (${live.error.code})`)
      continue
    }
    const problems: string[] = []
    const allowed = new Set(RESULT_FIELDS[c.tool] ?? [])
    for (const page of live.value) {
      const size = new TextEncoder().encode(JSON.stringify(page)).byteLength
      if (size >= RESULT_BUDGET_BYTES) problems.push('result over 24 KiB')
      // A null object (order: null) shows as its own path: fine when it's a prefix of listed paths.
      const extra = [...keyPaths(page)].filter(p => !allowed.has(p) && ![...allowed].some(a => a.startsWith(`${p}.`)))
      if (extra.length) problems.push(`fields outside the list: ${extra.filter(p => /^[A-Za-z.]{1,120}$/.test(p)).join(',')}`)
    }
    const fact = c.fact?.(live.value) ?? null
    if (fact) problems.push(`fact: ${fact}`)
    const fake = await runCase({ ...c, pages: live.value.length }, recorded)
    if (!fake.ok) problems.push(`recorded run failed (${fake.error.code})`)
    else {
      const d = firstDifference(normalise(live.value), normalise(fake.value))
      if (d) problems.push(`differs from the recording at ${d}`)
    }
    if (problems.length) fail(`case ${c.name}: ${problems.join('; ')}`)
    else print(`case ${c.name}: ok`)
  }
  return { failures }
}

export async function loadCommittedFixture(): Promise<unknown> {
  const url = new URL('../../upstreams/shopify/recordings/fixture/dataset.ts', import.meta.url).href
  return ((await import(/* @vite-ignore */ url)) as { dataset: unknown }).dataset
}
