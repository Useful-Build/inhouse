// A routine's schedule as people and the agent write it (p4-w2.md section 8) and back in words (section 9's `freq`,
// `day`): days as a mask, bit 0 Monday ... bit 6 Sunday.
import { z } from 'zod'

export const DAY_CODES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const
export const DAILY = 0b1111111
export const WEEKDAYS = 0b0011111

/** `days`: a list of day codes (each once), `'daily'` or `'weekdays'`. */
export const DaysSchema = z.union([
  z.literal('daily'), z.literal('weekdays'),
  z.array(z.enum(DAY_CODES)).min(1).max(7).refine(d => new Set(d).size === d.length, 'Each day once'),
])
export type Days = z.infer<typeof DaysSchema>

/** `HH:MM`, 24-hour. */
export const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export function daysMask(days: Days): number {
  if (days === 'daily') return DAILY
  if (days === 'weekdays') return WEEKDAYS
  return days.reduce((m, d) => m | (1 << DAY_CODES.indexOf(d)), 0)
}

export const parseTime = (time: string): { hour: number; minute: number } => ({ hour: Number(time.slice(0, 2)), minute: Number(time.slice(3, 5)) })

const dayNames = (mask: number) => DAY_NAMES.filter((_, i) => (mask & (1 << i)) !== 0)

/** The Routines page's `freq` and `day` (p4-w2.md section 9): Daily, Weekdays, or Weekly with day names. */
export function freqAndDay(mask: number): { freq: string; day: string } {
  if (mask === DAILY) return { freq: 'Daily', day: '' }
  if (mask === WEEKDAYS) return { freq: 'Weekdays', day: '' }
  return { freq: 'Weekly', day: dayNames(mask).join(', ') }
}

const list = (items: readonly string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/** The schedule in words for the agent: "Every day at 06:00", "Weekdays at 06:00", "Mondays and Thursdays at 06:00". */
export function scheduleWords(mask: number, time: string): string {
  if (mask === DAILY) return `Every day at ${time}`
  if (mask === WEEKDAYS) return `Weekdays at ${time}`
  return `${list(dayNames(mask).map(n => `${n}s`))} at ${time}`
}
