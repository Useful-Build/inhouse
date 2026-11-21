// The real client's usage reads (route 42, `GET /api/usage?month`): what the snapshot's `usage` and `usageMonths` come
// from. W4 writes them; the client (client.ts, W5) calls them on start and after a turn settles. No retries: a failure
// is the `AgentError` the transport throws.
import type { UsageData } from '../types'
import type { Transport } from './transport'

/** One month's usage (`YYYY-MM`; this month in the brand's zone when omitted). */
export function readUsage(transport: Transport, month?: string): Promise<UsageData> {
  return transport.call({ method: 'GET', path: month === undefined ? '/api/usage' : `/api/usage?month=${encodeURIComponent(month)}`, schema: 'usage' })
}

/**
 * This month, then every earlier month the server lists (`months`, newest first), read one after another: the snapshot's
 * `usage` (this month) and `usageMonths` (this month first), the shape the Usage page's month picker reads.
 */
export async function readUsageMonths(transport: Transport): Promise<{ usage: UsageData; usageMonths: UsageData[] }> {
  const usage = await readUsage(transport)
  const usageMonths = [usage]
  for (const m of (usage.months ?? []).filter(m => m !== usage.monthKey)) usageMonths.push(await readUsage(transport, m))
  return { usage, usageMonths }
}
