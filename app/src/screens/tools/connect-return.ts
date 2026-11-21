// Where the sign-in at a tool sends the browser back to (P5 W3, W1's route B): `/tools/<connector>?connected=1`,
// `/tools/<connector>?connect_error=<code>`, or `/tools?connect_error=<code>` when the account isn't known. The page
// says what happened from a closed list of lines, never from the address's text, and then drops the query.
import { CONNECT_ERROR_PARAM } from '../../../shared/contract/error-codes'

/** What each code the callback can send says. Any other code gets the last line. */
const MESSAGE: Record<string, string> = {
  state_invalid: 'That sign-in link has expired. Start the connection again.',
  workspace_mismatch: "That's a different Slack workspace. Sign in to the brand's workspace.",
  scope_mismatch: "The app's permissions don't match what we asked for. Check the app's scopes, then reconnect.",
  connect_refused: "The connection was declined. Start it again when you're ready.",
  // Neutral: the cause is a disconnect landing while the person signed in.
  connect_stale: 'Something changed while you signed in. Start the connection again.',
}
const FALLBACK = "We couldn't connect the tool. Try again."
const CONNECTED = 'The tool is connected.'

export interface ConnectReturn {
  /** The tool the return names, for the hash route (`#/tools/<key>`); null for `/tools`. */
  key: string | null
  /** The line to show. */
  text: string
  /** The connect worked. */
  ok: boolean
}

/** The return an address is, or null when it isn't one (any other path, or none of the two query parameters). */
export function parseConnectReturn(pathname: string, search: string): ConnectReturn | null {
  const m = /^\/tools(?:\/([a-z0-9-]{1,40}))?\/?$/.exec(pathname)
  if (!m) return null
  const q = new URLSearchParams(search)
  const key = m[1] ?? null
  if (q.get('connected') === '1') return key === null ? null : { key, text: CONNECTED, ok: true }
  const code = q.get(CONNECT_ERROR_PARAM)
  if (code === null) return null
  return { key, text: Object.hasOwn(MESSAGE, code) ? MESSAGE[code]! : FALLBACK, ok: false }
}
