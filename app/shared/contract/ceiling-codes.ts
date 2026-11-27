// Stage 1 M3-C (N26): the ceiling's refusal reason, for the Settings page (src/screens/settings/ceiling-words.ts). Its own
// file with no runtime imports, like error-codes.ts, so no snake_case string is in src/ (check-icons) and it loads with
// the Settings screen, not with Today (error-codes.ts loads with Today, under its size budget).
import type { ErrorReason } from './common.ts'

/** A change to the Inhouse ceiling while editing is off in this build (route 151). */
export const WRITES_OFF = 'writes_off' satisfies ErrorReason
