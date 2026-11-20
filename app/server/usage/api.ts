// The Usage page's API (P3, p3-design sections 3 and 9): route 42, `GET /api/usage?month=YYYY-MM`, baseline (member,
// admin, inhouse). From D1 only. `capReached` and `alertCrossed` are computed on every read from the cap as Settings
// holds it now and the month's spend, so a raised cap clears them at once. Money is shown in USD cents (`Money.minor`):
// the ledger is micro-USD, rounded half up to the cent here and only here.
import { z } from 'zod'
import type { UsageData, UsageRow } from '../../shared/contract/usage.ts'
import { readQuery, storesOf } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { apiError, apiJson } from '../http.ts'
import { CATALOG } from '../model/catalog.ts'
import { START_HOLD_MICRO } from './ledger.ts'
import { MONTH_KEY, monthName } from './month.ts'
import type { UsageGroupRow, UsageMonthView } from './store.ts'

const QuerySchema = z.object({ month: z.string().regex(MONTH_KEY).optional() }).strict()

// Each amount is rounded on its own, so rows and days may not sum to the total by a cent or so.
const money = (micro: number) => ({ minor: Math.round(micro / 10_000), currency: 'USD' })
const questions = (n: number) => `${n} ${n === 1 ? 'question' : 'questions'}`

/** "claude-sonnet-5-5" → "Sonnet 5.5" (the Usage page's model names). */
const modelName = (apiId: string) => {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(apiId)
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : apiId
}

const personRow = (r: UsageGroupRow): UsageRow => ({
  name: r.name ?? 'Former member', sub: questions(r.questions), spent: money(r.micro), conversations: r.conversations,
})
const modelRow = (r: UsageGroupRow): UsageRow => ({
  name: modelName(r.key), sub: CATALOG.find(m => m.apiId === r.key)?.label ?? questions(r.questions), spent: money(r.micro), conversations: r.conversations,
})

/** The view as the shared contract's `UsageData`. */
export function toUsageData(v: UsageMonthView): UsageData {
  return {
    month: monthName(v.month),
    monthKey: v.month,
    cap: money(v.capMicro),
    alertAt: v.alertPct,
    total: money(v.spentMicro),
    conversations: v.conversations,
    questionsAsked: v.questions,
    // Jobs are P4's.
    jobsRun: 0,
    daily: v.dailyMicro.map(money),
    // `job` and `tool` stay empty until P4 and P5.
    breakdown: { person: v.people.map(personRow), job: [], model: v.models.map(modelRow), tool: [] },
    // This month: "new chats are refused", the ledger's own reserve rule (cap − spent < the start hold), so the page and
    // the ledger never disagree (no cap reads as reached). A finished month: spend at or past the cap its ledger recorded.
    capReached: v.current ? v.capMicro - v.spentMicro < START_HOLD_MICRO : v.capMicro > 0 && v.spentMicro >= v.capMicro,
    alertCrossed: v.capMicro > 0 && v.spentMicro * 100 >= v.capMicro * v.alertPct,
    months: v.months,
  }
}

/** Route 42, `GET /api/usage?month`. W4. */
export async function getUsage(c: ApiCtx): Promise<Response> {
  const query = readQuery(c.request, QuerySchema)
  if ('error' in query) return query.error
  const view = await storesOf(c).usage.month({ month: query.ok.month ?? null, nowMs: c.nowMs })
  if (!view) return apiError('invalid')
  return apiJson(toUsageData(view))
}
