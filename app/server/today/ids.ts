// The ids Today derives (p4-w3.md sections 3 and 5). Never random: a re-delivered end, or a second read, names the same
// item, so a set-aside keeps matching.

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
const sha256 = async (text: string): Promise<string> => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))

/** A Today item: `p_` + 22 characters of SHA-256 of `<key>|<local date>` (OC 2: stable per problem and local date). */
export const itemId = async (key: string, localDate: string): Promise<string> => `p_${(await sha256(`${key}|${localDate}`)).slice(0, 22)}`

export type CardCause = 'incomplete' | 'failed' | 'not_run' | 'not_connected' | 'off'

/**
 * A status card's id, `p_check_<local date>_<cause>_<22 characters>` (audit.ts `TodayItemIdSchema`): the hash covers the
 * slot's key, or `<routineId>|<local date>` for the two causes with no slot (`not_run`, `off`), so each cause and slot has
 * its own id and dismissing one card never hides a later, different one.
 */
export const cardId = async (localDate: string, cause: CardCause, hashed: string): Promise<string> => `p_check_${localDate}_${cause}_${(await sha256(hashed)).slice(0, 22)}`
