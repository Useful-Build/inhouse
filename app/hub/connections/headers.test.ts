// One key-header denylist (connections/headers.ts, #731): prepare (index/schemas.ts) and the send (oauth/http.ts
// `validCredential`) refuse exactly the same names. Ways it could go wrong: a header prepare accepts that the send then
// refuses (a connection that can never be called), or one the send would attach that prepare should have refused.
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { ConnectionKeyPlaceSchema } from '../index/schemas'
import { validCredential } from '../oauth/http'
import { forbiddenKeyHeader, NEVER_SENT_HEADERS, TRANSPORT_HEADERS } from './headers'

const prepares = (header: string) => ConnectionKeyPlaceSchema.safeParse({ header, prefix: header.toLowerCase() === 'authorization' ? 'Bearer ' : '' }).success
const sends = (header: string) => validCredential({ header, value: 'Bearer k' })

describe('the key-header denylist', () => {
  const NAMED = [...TRANSPORT_HEADERS, ...NEVER_SENT_HEADERS, 'mcp-session-id', 'Mcp-Param-Folder', 'MCP-Protocol-Version', 'x-forwarded-for', 'X-Forwarded-Proto']

  it('every listed name, in any case, is refused at prepare and at the send', () => {
    for (const name of NAMED) {
      for (const h of [name, name.toUpperCase(), name.replace(/^./, c => c.toUpperCase())]) {
        expect(forbiddenKeyHeader(h), h).toBe(true)
        expect(prepares(h), `prepare ${h}`).toBe(false)
        expect(sends(h), `send ${h}`).toBe(false)
      }
    }
  })

  it('a key header a server would use passes both: X-Api-Key, Authorization with a scheme', () => {
    for (const h of ['X-Api-Key', 'Api-Key', 'Authorization', 'X-Token']) {
      expect(prepares(h), h).toBe(true)
      expect(sends(h), h).toBe(true)
    }
  })

  test.prop([fc.stringMatching(/^[A-Za-z0-9-]{1,40}$/)])('prepare and the send agree on every token header name', h => {
    expect(prepares(h)).toBe(sends(h))
  })
})
