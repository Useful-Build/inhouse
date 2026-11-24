// The demo's "Export everything" (P8a D): a small file in the product export's own shape (ops/export/export.ts, format
// 1: a header naming the stores, a line per row, then `{ end: true, counts }`), built from the demo's invented team and
// its saved settings. Nothing here is real data, and the demo has no server to stream it from.
import type { MemberRecord } from '../../agent/types'

/** The stores the sample holds, in the header's shape. The product's header lists every store in its registry. */
const STORES = [
  { kind: 'd1', name: 'members', retention: 'account', export: true },
  { kind: 'd1', name: 'settings', retention: 'config', export: true },
] as const

export function demoExport(members: readonly MemberRecord[], settings: Readonly<Record<string, string>>, atMs: number): string {
  const lines: unknown[] = [{ format: 1, kind: 'brand', atMs, sample: true, stores: STORES }]
  const team = members.filter(m => m.status !== 'removed').map(m => ({ id: m.id, name: m.name, email: m.email, title: m.title, role: m.role, status: m.status }))
  for (const row of team) lines.push({ store: 'members', row })
  const saved = Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of saved) lines.push({ store: 'settings', row: { key, value } })
  lines.push({ end: true, counts: { members: team.length, settings: saved.length } })
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n'
}
