// The ids a routine's slot derives (p4-w2.md section 4, step 3): its chat and its turn key come from the slot key alone,
// so a re-submit after a crash names the same chat and the same turn (P3 answers the original turn by `(chatId,
// clientTurnKey)` and the payload). A routine id is `rt_` + 128 random bits (audit.ts `RoutineIdSchema`).

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

const sha256 = async (text: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))

/** The slot's chat: `rc_` + 22 characters of SHA-256 of `chat|<slot key>`. */
export const slotChatId = async (slotKey: string): Promise<string> => `rc_${(await sha256(`chat|${slotKey}`)).slice(0, 22)}`

/** The slot's turn key: `rs_` + 40 characters of SHA-256 of `turn|<slot key>` (fits `^[A-Za-z0-9_-]{8,64}$`). */
export const slotClientKey = async (slotKey: string): Promise<string> => `rs_${(await sha256(`turn|${slotKey}`)).slice(0, 40)}`

/** A short id from a text (a notice id, a tool's Run now key): `prefix` + 40 characters of its SHA-256. */
export const hashId = async (prefix: string, text: string): Promise<string> => `${prefix}${(await sha256(text)).slice(0, 40)}`

export const newRoutineId = (): string => `rt_${b64url(crypto.getRandomValues(new Uint8Array(16)))}`

/** A Run now's slot key. */
export const manualSlotKey = (routineId: string, clientKey: string): string => `now|${routineId}|${clientKey}`

export const END_TASK_PREFIX = 'routine-end:'

/**
 * The `routine-end` task id of a slot: unique per turn chain, and no other kind uses the prefix. The slot key's `|` is
 * written `.` (no slot key holds a `.`), because route 51's revive takes task ids by audit.ts `TaskIdSchema`, which has
 * no `|`: the recovery for an exhausted end (p4-w2.md section 6) must be able to name it.
 */
export function endTaskId(slotKey: string): string {
  if (slotKey.includes('.')) throw new Error('endTaskId: a slot key never holds a "."')
  return `${END_TASK_PREFIX}${slotKey.replaceAll('|', '.')}`
}

/** A Run now's client key: the turn key shape without `.` (audit.ts `SlotKeySchema`), so its end id round-trips. */
export { ROUTINE_CLIENT_KEY as CLIENT_KEY } from '../../shared/contract/routines.ts'

/** The slot key an end task id names, or null when the id isn't a `routine-end` id. */
export function slotKeyOfEndTask(taskId: string): string | null {
  if (!taskId.startsWith(END_TASK_PREFIX)) return null
  const key = taskId.slice(END_TASK_PREFIX.length).replaceAll('.', '|')
  return key === '' ? null : key
}
