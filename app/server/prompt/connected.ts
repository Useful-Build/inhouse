// The system prompt v2's turn lines (P5, p5-orchestrator.md section 3 "Prompt", and W4's listed channels): the apps
// connected for the agent and the Slack channels it may post to, built when each turn starts. Orchestrator text: a
// change is a new prompt version with eval results.
//
// Connected means active, not paused and not `needsReconnect` (an account whose scopes no longer match has every tool
// hidden). A failed account read sends neither line: the prompt never claims an app we couldn't check.
import type { AccountSummary, ConnectGateway } from '../../hub/index/contract.ts'
import { catalogByAccount } from '../api/tools-catalog.ts'
import { listedChannels } from '../notify-slack/send.ts'
import { SYSTEM_PROMPT_V1, systemPromptV2 } from './system.ts'

export const NO_APPS_LINE = 'No apps are connected yet.'
export const connectedAppsLine = (names: string): string =>
  `Connected apps: ${names}. Search for their tools with tool search when a question needs their data.`
export const listedChannelsLine = (names: string): string =>
  `Slack channels you may post to with notification_send: ${names}. Post nowhere else.`

/** Slack's channel name rule. A stored name outside it never reaches the prompt (it could carry prompt text). */
export const SLACK_CHANNEL_NAME = /^[a-z0-9_-]{1,80}$/
const SLACK_ACCOUNT = 'slack:workspace'

const isConnected = (a: AccountSummary): boolean =>
  a.configured && a.status.state === 'active' && !a.status.paused && !a.status.needsReconnect
const slackConnected = (accounts: readonly AccountSummary[]): boolean =>
  accounts.some(a => a.accountId === SLACK_ACCOUNT && isConnected(a))
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** How many connected accounts the connector catalog doesn't know (named by nobody; logged loud per turn). */
export const unknownConnected = (accounts: readonly AccountSummary[]): number =>
  accounts.filter(a => isConnected(a) && catalogByAccount(a.accountId) === undefined).length

/** "X", "X and Y", "X, Y and Z" (no Oxford comma). */
export function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`
}

/**
 * The turn lines: `accounts` from listAccounts (null when it couldn't be read: no lines at all), `channels` the listed
 * Slack channel names (W4's list; pass none when Slack delivery isn't bound). Names come from the connector catalog; an
 * account the catalog doesn't know is left out, never named by its id.
 */
export function connectedLines(accounts: readonly AccountSummary[] | null, channels: readonly string[]): string {
  if (accounts === null) return ''
  const names = [...new Set(accounts.filter(isConnected).flatMap(a => catalogByAccount(a.accountId)?.name ?? []))].sort(byCodeUnit)
  // A connected account the catalog can't name: "none" would be false, so no apps line at all (and Slack, which the
  // catalog names, isn't connected, so no channel line either).
  if (names.length === 0 && unknownConnected(accounts) > 0) return ''
  const lines = [names.length === 0 ? NO_APPS_LINE : connectedAppsLine(joinNames(names))]
  const safe = [...new Set(channels.filter(c => SLACK_CHANNEL_NAME.test(c)))].sort(byCodeUnit)
  if (slackConnected(accounts) && safe.length > 0) lines.push(listedChannelsLine(joinNames(safe.map(c => `#${c}`))))
  return lines.join('\n')
}

export type TurnPromptDeps = {
  /** `HUB_CONNECT`, or null when the binding is missing (read as "couldn't check"). */
  gateway: Pick<ConnectGateway, 'listAccounts'> | null
  /** Whether `HUB_DELIVERY` is bound (Slack delivery set up on the server side). */
  delivery: boolean
  /** The listed channel names. */
  channels: () => Promise<readonly string[]>
}

/** The production deps from the product Worker's env. */
export function turnPromptDeps(env: { DB: D1Database; HUB_CONNECT?: unknown; HUB_DELIVERY?: unknown }): TurnPromptDeps {
  return {
    gateway: (env.HUB_CONNECT as Pick<ConnectGateway, 'listAccounts'> | undefined) ?? null,
    delivery: env.HUB_DELIVERY !== undefined,
    channels: async () => (await listedChannels(env.DB)).map(c => c.name),
  }
}

/** A log line, dropped once the turn's deadline has passed (the turn already went out without this read). */
type Log = (line: Record<string, unknown>) => void
const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err)

async function readAccounts(deps: TurnPromptDeps, turnId: string, log: Log): Promise<readonly AccountSummary[] | null> {
  if (deps.gateway === null) {
    log({ event: 'prompt_accounts_unread', turnId, code: 'no_binding' })
    return null
  }
  try {
    const r = await deps.gateway.listAccounts({ kind: 'server', job: 'prompt.turn', requestId: turnId })
    if (r.ok) return r.value
    log({ event: 'prompt_accounts_unread', turnId, code: r.error.code })
  } catch (err) {
    log({ event: 'prompt_accounts_unread', turnId, code: 'threw', error: errorName(err) })
  }
  return null
}

async function readChannels(deps: TurnPromptDeps, turnId: string, log: Log): Promise<readonly string[]> {
  try {
    return await deps.channels()
  } catch (err) {
    log({ event: 'prompt_channels_unread', turnId, error: errorName(err) })
    return []
  }
}

/** The longest a turn's start waits for the hub and the channel list together (A9's condition). */
export const PROMPT_READ_DEADLINE_MS = 3000

/**
 * The system prompt v2 for one turn. Never throws, by construction. One deadline covers both reads: the accounts past
 * it send v1; the channels past it (accounts already read) keep the apps line and drop the channel line. A failed read
 * is logged and its line left out; a read that loses to the deadline logs nothing more.
 */
export async function turnSystemPrompt(deps: TurnPromptDeps, turnId: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const log: Log = line => { if (!expired) console.error(line) }
  try {
    const deadline = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => { expired = true; resolve('timeout') }, PROMPT_READ_DEADLINE_MS)
    })
    const accounts = await Promise.race([readAccounts(deps, turnId, log), deadline])
    if (accounts === 'timeout') {
      console.error({ event: 'prompt_accounts_unread', turnId, code: 'timeout' })
      return SYSTEM_PROMPT_V1
    }
    if (accounts !== null) {
      const unknown = unknownConnected(accounts)
      if (unknown > 0) log({ event: 'prompt_unknown_connectors', turnId, count: unknown })
    }
    let channels: readonly string[] = []
    if (accounts !== null && deps.delivery && slackConnected(accounts)) {
      const read = await Promise.race([readChannels(deps, turnId, log), deadline])
      if (read === 'timeout') console.error({ event: 'prompt_channels_unread', turnId, code: 'timeout' })
      else {
        channels = read
        const dropped = channels.filter(c => !SLACK_CHANNEL_NAME.test(c)).length
        if (dropped > 0) log({ event: 'prompt_channel_names_dropped', turnId, dropped })
      }
    }
    return systemPromptV2(connectedLines(accounts, channels))
  } catch (err) {
    console.error({ event: 'prompt_build_failed', turnId, error: errorName(err) })
    return SYSTEM_PROMPT_V1
  } finally {
    clearTimeout(timer)
  }
}
