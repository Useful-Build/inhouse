// The nightly's way to the deployed hub (P5 W5 section 1): `NightlyHub` is what the cases need, `httpNightlyHub` is its one
// real implementation, over the product Worker's ops path the nightly already uses for Shopify. THE PATH IS THE
// ORCHESTRATOR'S: `POST <NIGHTLY_BASE_URL>/api/ops/connector-check` with a JSON `{op, ...}`, signed in as the nightly's Access
// service token (`CF-Access-Client-Id` and `CF-Access-Client-Secret`), answering `{ok: true, value}` or `{ok: false, code}`.
// The ops are written below; none of them returns a token, code, verifier or secret. Cases take a `NightlyHub`, so a node test
// can run them against a hand-made one (cases.test.ts's neighbour, run.test.ts), and this file is the only place that names
// the path.

/** The account's state as the hub reports it (the fields the cases read). */
export type HubAccount = { accountId: string; state: 'empty' | 'active' | 'failed' | 'disconnected'; scopes: string[]; needsReconnect: boolean; paused: boolean }
/** A tool of Slack's live `tools/list`: its name, its input property names and whether it is read only (the hint). */
export type LiveTool = { name: string; properties: string[]; readOnly: boolean | null }
export type Discovery = {
  /** PRM's `resource`. */
  prmResource: string
  /** The authorization server's endpoints and PKCE methods. */
  authorization: string
  token: string
  revoke: string
  codeChallengeMethods: string[]
}
export type HubOutcome<T> = { ok: true; value: T } | { ok: false; code: string }

export interface NightlyHub {
  account(accountId: string): Promise<HubOutcome<HubAccount>>
  /** The tools a run would see (ReadGateway.listTools with a server scope). */
  listTools(): Promise<HubOutcome<{ name: string }[]>>
  callTool(name: string, args: unknown): Promise<HubOutcome<{ data: unknown }>>
  /** Slack's live `tools/list`, through the nightly-only probe method on the hub (an orchestrator addition). */
  liveTools(accountId: string): Promise<HubOutcome<LiveTool[]>>
  /** Posts a notice to a channel the way notification_send does at Act (the hub's delivery), as a real notice. */
  postNotice(channelId: string, title: string, text: string): Promise<HubOutcome<{ ts: string }>>
  /** `conversations.history` for one message, read back through the house app: what is attached or unfurled on it. */
  readBack(channelId: string, ts: string): Promise<HubOutcome<{ text: string; attachments: number; unfurled: boolean }>>
  /** Slack's live PRM and authorization-server metadata, fetched by the hub. */
  discovery(accountId: string): Promise<HubOutcome<Discovery>>
  /** With rotation on: runs the account's alarm-driven refresh once, then tries the previous refresh token (refused by Slack). */
  rotate(accountId: string): Promise<HubOutcome<{ refreshed: boolean; oldTokenRefused: boolean }>>
}

export const NIGHTLY_ENV = ['NIGHTLY_BASE_URL', 'NIGHTLY_ACCESS_CLIENT_ID', 'NIGHTLY_ACCESS_CLIENT_SECRET', 'NIGHTLY_SLACK_CHANNEL_ID', 'NIGHTLY_SLACK_NOTICES_CHANNEL_ID'] as const

export function httpNightlyHub(env: Record<string, string | undefined>, fetcher: typeof fetch = fetch): NightlyHub {
  const base = env.NIGHTLY_BASE_URL
  const id = env.NIGHTLY_ACCESS_CLIENT_ID
  const secret = env.NIGHTLY_ACCESS_CLIENT_SECRET
  if (!base || !id || !secret) throw new Error('nightly: NIGHTLY_BASE_URL, NIGHTLY_ACCESS_CLIENT_ID and NIGHTLY_ACCESS_CLIENT_SECRET must be set (the check fails, never skips)')
  const op = async <T>(body: Record<string, unknown>): Promise<HubOutcome<T>> => {
    const res = await fetcher(`${base.replace(/\/+$/, '')}/api/ops/connector-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
      body: JSON.stringify(body),
    })
    // Names and codes only: a body is never printed (it could carry store or workspace data).
    if (res.status !== 200) return { ok: false, code: `http_${res.status}` }
    return (await res.json()) as HubOutcome<T>
  }
  return {
    account: accountId => op({ op: 'account', accountId }),
    listTools: () => op({ op: 'listTools' }),
    callTool: (name, args) => op({ op: 'callTool', name, args }),
    liveTools: accountId => op({ op: 'liveTools', accountId }),
    postNotice: (channelId, title, text) => op({ op: 'postNotice', channelId, title, text }),
    readBack: (channelId, ts) => op({ op: 'readBack', channelId, ts }),
    discovery: accountId => op({ op: 'discovery', accountId }),
    rotate: accountId => op({ op: 'rotate', accountId }),
  }
}
