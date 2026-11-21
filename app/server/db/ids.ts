// Ids from random bytes (never from a name or an email): a member id is 'm_' + 128 random bits, a grant id 'g_' + 128.

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export const newMemberId = (): string => `m_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`
export const newGrantId = (): string => `g_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

/**
 * What one write stamps on the row it changes (`req_id`): the request id plus a per-write suffix. The audit insert's
 * `WHERE EXISTS (... AND req_id = <stamp>)` then matches only the row this very statement changed, even when an
 * earlier write in the same request (a first sign-in's bind, say) stamped the same row.
 */
export const writeStamp = (requestId: string): string => {
  const suffix = [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${requestId}#${suffix}`
}

/** The id the system row has (migration 0005): the actor of lines nobody caused. */
export const SYSTEM_MEMBER_ID = 'm_system'
