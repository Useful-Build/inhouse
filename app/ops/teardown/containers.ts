// Container-only step of the backend runbook. The private ops workflow owns
// approval, pause, backup and deletion of all other resources.
import { parseArgs } from 'node:util'

const API = 'https://api.cloudflare.com/client/v4/'
const VERIFY_TIMEOUT_MS = 60_000

type ApiEnvelope = { success?: unknown; result?: unknown; result_info?: { next_page_token?: unknown } }
type Application = { id: string; name: string }
type Inventory = { phase: 'before' | 'after'; brand: string; applications: Application[] }
type Options = {
  accountId?: string
  prefix?: string
  allInDedicatedAccount?: boolean
  brand?: string
  approvedBy?: string
  house?: boolean
  houseApproved?: boolean
  apply?: boolean
  token?: string
  fetchApi?: (url: URL, init: RequestInit) => Promise<Response>
  report?: (entry: Inventory) => void
  now?: () => number
  wait?: () => Promise<void>
}

export async function teardownContainers({
  accountId, prefix, allInDedicatedAccount = false, brand, approvedBy,
  house = false, houseApproved = false, apply = false, token,
  fetchApi = fetch, report = console.log, now = Date.now,
  wait = () => new Promise(resolve => setTimeout(resolve, 2000)),
}: Options) {
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId)) throw new Error('A Cloudflare account ID is required')
  if (allInDedicatedAccount ? prefix !== undefined : !prefix || !/^[a-z0-9][a-z0-9_-]*[_-]$/.test(prefix)) {
    throw new Error('Specify one scope: a deployment-specific prefix ending in _ or -, or the dedicated account')
  }
  if (!brand?.trim() || !token?.trim()) throw new Error('A brand ID and Cloudflare API token are required')
  if (apply && (!approvedBy?.trim() || ((house || brand === 'house') && !houseApproved))) {
    throw new Error('Teardown requires written Admin approval, plus Wasim’s approval for house')
  }

  const endpoint = new URL(`accounts/${accountId}/containers/applications`, API)
  async function call(url: URL, method: 'GET' | 'DELETE') {
    const response = await fetchApi(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${token}` },
    })
    if (!response.ok) throw new Error(`Cloudflare Containers ${method} failed (HTTP ${response.status})`)
    const body = await response.json() as ApiEnvelope | null
    if (body?.success !== true) throw new Error(`Cloudflare Containers ${method} reported failure`)
    return body
  }

  async function list() {
    const apps = new Map<string, Application>()
    const seenTokens = new Set<string>()
    const url = new URL(endpoint)
    url.searchParams.set('per_page', '100')
    for (;;) {
      const { result, result_info: page } = await call(url, 'GET')
      if (!Array.isArray(result)) throw new Error('Cloudflare Containers returned an invalid application list')
      for (const app of result) {
        if (typeof app?.name !== 'string' || typeof app.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(app.id)) {
          throw new Error('Cloudflare Containers returned an invalid application')
        }
        if (prefix === undefined || app.name.startsWith(prefix)) apps.set(app.id, { id: app.id, name: app.name })
      }
      if (page != null && (typeof page !== 'object' || Array.isArray(page))) {
        throw new Error('Cloudflare Containers returned invalid pagination metadata')
      }
      const next = page?.next_page_token
      if (next === undefined || next === null || next === '') return [...apps.values()]
      if (typeof next !== 'string' || seenTokens.has(next)) throw new Error('Cloudflare Containers returned an invalid page token')
      seenTokens.add(next)
      url.searchParams.set('page_token', next)
    }
  }

  const before = await list()
  report({ phase: 'before', brand, applications: before })
  if (!apply) return
  const failures: Error[] = []
  for (const app of before) {
    const url = new URL(endpoint)
    url.pathname += `/${app.id}`
    try {
      await call(url, 'DELETE')
    } catch (error) {
      failures.push(new Error(`Delete failed for ${app.name} (${app.id})`, { cause: error }))
    }
  }

  const deadline = now() + VERIFY_TIMEOUT_MS
  let after: Application[]
  try {
    // Cloudflare starts deletion asynchronously. Verify with fresh lists and
    // stop immediately if a new matching application appeared during cleanup.
    const deleting = new Set(before.map(app => app.id))
    after = await list()
    while (after.length && !failures.length && after.every(app => deleting.has(app.id)) && now() < deadline) {
      await wait()
      after = await list()
    }
  } catch (error) {
    throw new AggregateError([...failures, error], 'Could not verify the container applications after teardown')
  }
  report({ phase: 'after', brand, applications: after })
  if (after.length) failures.push(new Error(`Container applications remain: ${after.map(app => app.name).join(', ')}`))
  if (failures.length) throw new AggregateError(failures, 'Container teardown failed')
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      'account-id': { type: 'string' },
      prefix: { type: 'string' },
      'all-in-dedicated-account': { type: 'boolean' },
      brand: { type: 'string' },
      'approved-by': { type: 'string' },
      house: { type: 'boolean' },
      'house-approved': { type: 'boolean' },
      apply: { type: 'boolean' },
    } })
    await teardownContainers({
      accountId: values['account-id'], prefix: values.prefix,
      allInDedicatedAccount: values['all-in-dedicated-account'], brand: values.brand,
      approvedBy: values['approved-by'], house: values.house, houseApproved: values['house-approved'],
      apply: values.apply, token: process.env.CLOUDFLARE_API_TOKEN,
      report: entry => console.log(JSON.stringify(entry)),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Container teardown failed')
    if (error instanceof AggregateError) for (const detail of error.errors) {
      console.error(detail instanceof Error ? detail.message : 'Container API call failed')
    }
    process.exitCode = 1
  }
}
