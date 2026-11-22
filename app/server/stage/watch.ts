// The Watch switches (P8a S; decision log "Stages", "urgent alerts go to Slack from Act"): at stage Watch a notice
// reaches the in-app bell only, and nothing writes outside Inhouse. "Outside" means a write that leaves the account
// (Shopify, Slack, email, any other outside system); a write to Inhouse's own D1 and R2 (memory, team requests, bell
// notices, routines, the Library) is not one, and this switch never refuses it (a tool's own stage rule still applies:
// P4's routine_create needs Act for a person's routine). Which tools write outside is explicit, per MCP server
// (`toolWriteRefusal`), never "any write". The server decides from the brand's stored stage, never from the client, the
// runner or the model. Every path that delivers a notice or writes outside Inhouse asks here first, with the stage read
// fresh from D1:
// - the egress's hub route (server/egress/hub.ts): at Watch, only a tool the hub lists as read is called;
// - P5's `notification_send` (`server/mcp/tools/notifications/`, `server/notify-slack/`): `deliveryRefusal` per channel;
// - P6's outbox (`server/outbox/policy.ts`, at request time and again at dispatch): `externalWriteRefusal`.
import { stageIndex } from '../routines/brand.ts'

export const WATCH = 0
export const ACT = 1
export const RUN = 2

/** The one channel Watch delivers to: the in-app bell (server/notices). */
export const BELL = 'bell'

/**
 * The brand's stage index (0 Watch, 1 Act, 2 Run). Missing, reset (null), unknown or unparseable is Watch: a broken value
 * never opens a door.
 */
export async function brandStage(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'stage'").first<{ value_json: string }>()
  if (!row) return WATCH
  try {
    return stageIndex(JSON.parse(row.value_json))
  } catch {
    return WATCH
  }
}

/** Below Act, or not a stage index at all. */
const belowAct = (stage: number) => !(Number.isInteger(stage) && stage >= ACT && stage <= RUN)

/**
 * Why a notice may not go out on `channel` at `stage` (the shared `stage` error code), or null. At Watch only the bell;
 * from Act the stage allows any channel, and the channel's own rules (P5's listed channels) still apply.
 */
export function deliveryRefusal(stage: number, channel: string): 'stage' | null {
  if (channel === BELL) return null
  return belowAct(stage) ? 'stage' : null
}

/** Why a write outside Inhouse (a connector write, a post, a send) may not run at `stage`, or null. Refused at Watch. */
export function externalWriteRefusal(stage: number): 'stage' | null {
  return belowAct(stage) ? 'stage' : null
}

/**
 * The `inhouse` MCP server's tools that write outside Inhouse: none. Its tools write only Inhouse's own D1 and R2
 * (memory, approvals, questions, routines, history, team requests); `notification_send`'s Slack post is a delivery,
 * checked per channel by `deliveryRefusal`. A tool added here is refused at Watch.
 */
export const INHOUSE_EXTERNAL_WRITE_TOOLS: readonly string[] = []

/**
 * Why a tool call may not run at `stage` because it writes outside Inhouse, or null. By server:
 * - `inhouse`: only a tool on `INHOUSE_EXTERNAL_WRITE_TOOLS`;
 * - `apps` (the connector hub): every tool reaches an outside system, so one runs at Watch only when the hub's read list
 *   (`hubReads`, read for this call) names it; anything else is a write or unknown, and refused.
 */
export function toolWriteRefusal(stage: number, server: 'inhouse' | 'apps', name: string, hubReads: ReadonlySet<string> = new Set()): 'stage' | null {
  if (externalWriteRefusal(stage) === null) return null
  if (server === 'inhouse') return INHOUSE_EXTERNAL_WRITE_TOOLS.includes(name) ? 'stage' : null
  return hubReads.has(name) ? null : 'stage'
}
