// The sign-in return: a closed list of lines (never the address's text), the key a route can name, and every other address
// ignored. Ways it can fail: a code echoed into the toast, a path that isn't the Tools one taken for a return, `connected`
// with anything but 1 taken as success.
import { describe, expect, test } from 'vitest'
import { parseConnectReturn } from './connect-return'

describe('parseConnectReturn', () => {
  test('a success names its tool', () => {
    expect(parseConnectReturn('/tools/slack', '?connected=1')).toEqual({ key: 'slack', text: 'The tool is connected.', ok: true })
    expect(parseConnectReturn('/tools/slack/', '?connected=1')?.key).toBe('slack')
  })
  test('each listed code has its line', () => {
    const line = (code: string) => parseConnectReturn('/tools/slack', `?connect_error=${code}`)?.text
    expect(line('state_invalid')).toBe('That sign-in link has expired. Start the connection again.')
    expect(line('workspace_mismatch')).toBe("That's a different Slack workspace. Sign in to the brand's workspace.")
    expect(line('scope_mismatch')).toBe("The app's permissions don't match what we asked for. Check the app's scopes, then reconnect.")
    expect(line('connect_refused')).toBe("The connection was declined. Start it again when you're ready.")
    expect(line('connect_stale')).toBe('Something changed while you signed in. Start the connection again.')
  })
  test('any other code, listed or not, gets the plain line and is never echoed', () => {
    for (const code of ['rate_limited', 'internal', 'toString', '__proto__', encodeURIComponent('<b>hi</b>')]) {
      const r = parseConnectReturn('/tools/slack', `?connect_error=${code}`)
      expect(r?.text, code).toBe("We couldn't connect the tool. Try again.")
    }
  })
  test('/tools with an error names no tool; /tools with a success is not a return', () => {
    expect(parseConnectReturn('/tools', '?connect_error=state_invalid')).toEqual({ key: null, text: 'That sign-in link has expired. Start the connection again.', ok: false })
    expect(parseConnectReturn('/tools', '?connected=1')).toBeNull()
  })
  test('other paths and queries are not returns', () => {
    expect(parseConnectReturn('/', '?connected=1')).toBeNull()
    expect(parseConnectReturn('/chats/tools', '?connected=1')).toBeNull()
    expect(parseConnectReturn('/tools/slack', '')).toBeNull()
    expect(parseConnectReturn('/tools/slack', '?connected=2')).toBeNull()
    expect(parseConnectReturn('/tools/Slack%20x', '?connected=1')).toBeNull()
    expect(parseConnectReturn('/tools/a/b', '?connected=1')).toBeNull()
  })
})
