// What the egress works with (p3-design 8.1), injected so every route is tested against fakes: the BrandAgent's RPC,
// the Runner's `touch`, the model upstream, R2 and D1, the clock and timers, `waitUntil` and a log without secrets.
import type { KeyedBucket } from '../db/r2-keys.ts'
import type { BrandAgentRpc } from '../do/brand-agent/ports.ts'
import type { SettingsView } from '../model/catalog.ts'
import type { ModelUpstream } from './gateway.ts'

/**
 * The BrandAgent's RPC as the egress uses it. `noteCountTokens` (the CLI's own counts, 50 per turn) is the
 * orchestrator's addition to `BrandAgentRpc` (W1 adds it to ports.ts in #142); until then it's declared here.
 */
export type EgressRpc = BrandAgentRpc & {
  /** Notes one CLI `count_tokens` call of the turn: true while under 50, false after. */
  noteCountTokens(turnId: string): Promise<boolean>
}

/** The `inhouse` MCP handler (W6, `app/server/mcp/server.ts`); scoped to the grant's ids only. */
export type McpHandler = (request: Request, scope: { memberId: string; chatId: string; runId: string; turnId: string }) => Promise<Response>

export interface EgressDeps {
  rpc: EgressRpc
  /** The intercept's props: the runner this container belongs to (W2 registers `{ runner, containerGen }`). */
  runner: string
  /** `runner.touch()` on that Runner object (W2): resets its inactivity on every push (section 1). */
  touchRunner(runner: string): Promise<void>
  upstream: ModelUpstream
  /** The brand's technical settings as they are now (the switched-off model, item 13). */
  settings(): Promise<SettingsView>
  /** R2, keys only from r2-keys.ts. */
  bucket: KeyedBucket
  db: D1Database
  mcp: McpHandler
  waitUntil(p: Promise<unknown>): void
  setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval(t: ReturnType<typeof setInterval>): void
  newCallId(): string
  now(): number
  /** Never a token, hash, key, body or upstream diagnostics. */
  log(entry: Record<string, unknown>): void
}
