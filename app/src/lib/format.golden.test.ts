// The golden file of display strings (P1, C1): every sample value that is an instant, an amount, a schedule time or a
// duration, as the UI shows it before C1 changes any formatter. The keys name where the string shows; the values are what
// today's code writes there. Written by `npx vitest run src/lib/format.golden.test.ts -u` (a file snapshot); a plain run
// checks that today's code still writes exactly what the file holds. C1's differential test takes over this file:
// the new formatters, fed the new `{ iso, ms }`, `{ minor, currency }`, `{ hour, minute }` and ms values, must write the
// same strings.
import { expect, test, vi } from 'vitest'
import tracesJson from '@sample/traces.json'
import type { AgentData, AgentState, Scenario, Stage, StageIndex, Trace } from '../agent/types'

// The mock reads and writes localStorage when it starts: an empty one in memory, so it starts fresh and quietly.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('../agent/mock')
const { DEMO_LATEST, DEMO_START, demoNow, fmtCount, fmtDay, fmtTime, fmtWeekday, parseLocal } = await import('../agent/clock')
const { capStatus, fmtSeconds, toolView, whenOf } = await import('../state/derive')

// Two screen-local formatters, copied as they are today (C1 moves both into format.ts):
/** src/screens/Usage.tsx:15, the Usage page's amounts. */
const usageMoney = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** src/screens/settings/content.ts:206, the Settings rows "Monthly cap" and "Spent so far". */
const settingsCap = (cap: number) => `$${cap}`
const settingsSpent = (spent: number) => `$${spent.toFixed(2)}`

const agent = new MockAgent()
const SCENARIO_KEY: Record<Scenario, string> = { Normal: 'normal', 'First day': 'firstDay', Loading: 'loading', 'Tool disconnected': 'toolDisconnected', 'Cap reached': 'capReached' }
/** The data, state and a Ctx for a stage and scenario. */
const at = (stage: Stage, scenario: Scenario) => {
  agent.setDemo({ stage, scenario })
  const data: AgentData = agent.read()
  const st: AgentState = agent.getSnapshot()
  return { data, ctx: { S: (['Watch', 'Act', 'Run'] as const).indexOf(stage) as StageIndex, scenario, agent: st, data } }
}

function capture(): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (k: string, v: string) => {
    if (Object.hasOwn(out, k)) throw new Error(`Golden key twice: ${k}`)
    out[k] = v
  }

  // ---------- the demo clock: what every stamp (approved, set aside, paused, Run now, a chat started) is written with
  put('clock.start.time', fmtTime(DEMO_START))
  put('clock.start.day', fmtDay(DEMO_START))
  put('clock.start.weekday', fmtWeekday(DEMO_START))
  put('clock.latest.time', fmtTime(DEMO_LATEST))
  put('clock.plus3min.time', fmtTime(demoNow(0, 3 * 60_000)))
  put('clock.plus1h59.time', fmtTime(demoNow(0, 119 * 60_000)))

  const { data, ctx } = at('Act', 'Normal')

  // ---------- chats: the list's time or date and its group, the work rows and the routine cards
  for (const c of data.chat.chats) {
    put(`chats.${c.id}.at`, c.at)
    put(`chats.${c.id}.day`, c.day)
    c.turns.forEach((t, ti) => {
      if (t.role !== 'agent') return
      t.parts.forEach((p, pi) => {
        const k = `chats.${c.id}.turn${ti}.part${pi}`
        if (p.type === 'workRow') put(`${k}.time`, p.time)
        if (p.type === 'routine') {
          put(`${k}.routine.time`, p.routine.time)
          put(`${k}.routine.when`, whenOf(p.routine))
          put(`${k}.routine.next`, p.routine.next)
        }
      })
    })
  }

  // ---------- Library: the card's date, the viewer's Date row and a media file's length
  for (const f of agent.listFiles()) {
    put(`library.${f.id}.date`, f.date)
    put(`library.${f.id}.viewerDate`, `${fmtWeekday(parseLocal(f.at))}, ${fmtTime(parseLocal(f.at))}`)
    if (f.duration !== undefined) put(`library.${f.id}.duration`, f.duration)
  }

  // ---------- Activity's fixed lines and the audit log
  data.activity.today.forEach((l, i) => put(`activity.today.${i}.t`, l.t))
  data.activity.earlier.forEach((l, i) => {
    put(`activity.earlier.${i}.day`, l.day ?? '')
    put(`activity.earlier.${i}.t`, l.t)
  })
  data.auditLog.forEach((e, i) => {
    put(`audit.${i}.day`, e.day)
    put(`audit.${i}.at`, e.at)
  })

  // ---------- the bell
  for (const n of agent.listNotifications()) put(`notifications.${n.id}.at`, n.at)

  // ---------- problems: the amount on the card and when the draft was made
  for (const p of data.problems) {
    put(`problems.${p.id}.cost`, p.cost)
    put(`problems.${p.id}.draftedAt`, p.draftedAt)
  }

  // ---------- tools and channels: connected since, last read, going live
  for (const key of Object.keys(data.tools.details)) {
    const v = toolView(ctx, key)
    put(`tools.${key}.since`, data.tools.details[key].since)
    put(`tools.${key}.listLine`, v.listLine)
    put(`tools.${key}.connectedRow`, v.connectedRow)
    put(`tools.${key}.lastRead`, v.lastRead)
  }
  for (const c of data.tools.channels) put(`channels.${c.key}.since`, c.since)
  const disc = at('Act', 'Tool disconnected')
  const lost = disc.data.scenarios.toolDisconnected
  put('scenarios.toolDisconnected.at', lost.at)
  put(`scenarios.toolDisconnected.${lost.tool}.statusText`, toolView(disc.ctx, lost.tool).statusText)
  put(`scenarios.toolDisconnected.${lost.tool}.lastRead`, toolView(disc.ctx, lost.tool).lastRead)

  // ---------- routines: the schedule, the next run and the last run
  for (const r of at('Act', 'Normal').data.routines) {
    put(`routines.${r.id}.time`, r.time)
    put(`routines.${r.id}.when`, whenOf(r))
    put(`routines.${r.id}.next`, r.next)
    if (r.last !== undefined) put(`routines.${r.id}.last`, r.last)
  }

  // ---------- traces: cost, how long the run and each step took
  const traceLines = (prefix: string, t: Trace) => {
    put(`${prefix}.cost`, t.cost)
    put(`${prefix}.duration`, fmtSeconds(t.duration))
    t.steps.forEach((s, i) => put(`${prefix}.steps.${i}`, fmtSeconds(s.end - s.start)))
  }
  const traceIds = Object.keys(tracesJson.traces)
  at('Act', 'Normal')
  for (const id of traceIds) {
    const t = agent.getTrace(id)
    if (!t) throw new Error(`No trace ${id}`)
    traceLines(`traces.${id}`, t)
  }
  at('Act', 'Tool disconnected')
  traceLines('traces.morning@toolDisconnected', agent.getTrace('morning')!)

  // ---------- Usage: every month and every scenario with spend
  for (const sc of ['Normal', 'Cap reached'] as const) {
    const u = at('Act', sc)
    const status = capStatus(u.ctx)
    const s = SCENARIO_KEY[sc]
    put(`usage.${s}.capBanner`, status.bannerText)
    put(`usage.${s}.settings.cap`, settingsCap(u.data.usage.cap))
    put(`usage.${s}.settings.spent`, settingsSpent(status.spent))
    for (const m of u.data.usageMonths) {
      const k = `usage.${s}.${m.month}`
      put(`${k}.card`, `${usageMoney(m.total)} of $${fmtCount(m.cap)}`)
      put(`${k}.capHint`, `$${fmtCount(m.cap)}`)
      put(`${k}.projection`, `$${fmtCount(Math.round(m.total / m.daily.length * 30))}`)
      put(`${k}.peak`, usageMoney(Math.max(...m.daily)))
      m.daily.forEach((v, i) => put(`${k}.daily.${i}`, usageMoney(v)))
      for (const [tab, rows] of Object.entries(m.breakdown)) rows.forEach((r, i) => put(`${k}.${tab}.${i}`, usageMoney(r.dollars)))
    }
  }
  at('Act', 'Normal')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The file as JSON with no-break spaces written as `\u00a0`, so a reader sees where the UI keeps a time on one line. */
const serialize = (x: Record<string, string>) => JSON.stringify(x, null, 2).replaceAll('\u00a0', '\\u00a0') + '\n'

test("the golden file holds what today's code shows for every time, amount, schedule and duration in the sample data", async () => {
  await expect(serialize(capture())).toMatchFileSnapshot('./format.golden.json')
})
