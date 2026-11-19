// The golden file of display strings (P1, C1): every sample value that is an instant, an amount, a schedule time or a
// duration, as the UI shows it before C1 changes any formatter. The keys name where the string shows; the values are what
// today's code writes there. Written by `npx vitest run src/lib/format.golden.test.ts -u` (a file snapshot); a plain run
// checks that today's code still writes exactly what the file holds. C1's differential test takes over this file:
// the new formatters, fed the new `{ iso, ms }`, `{ minor, currency }`, `{ hour, minute }` and ms values, must write the
// same strings.
// The strings that change with the stage or the scenario (chats, Library, Activity, the audit log, the bell, problems,
// tools and routines) are captured in Act on a normal day, then again in Watch, in Run and on the First day: a variant
// is written as `<key>@<variant>` only where its string differs from Act's or Act has no such key.
import { expect, test, vi } from 'vitest'
import tracesJson from '@sample/traces.json'
import type { AgentData, AgentState, RoutineCard, RunEvent, Scenario, Stage, StageIndex, Trace } from '../agent/types'

// The mock reads and writes localStorage when it starts: an empty one in memory, so it starts fresh and quietly.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('../agent/mock')
const { DEMO_LATEST, DEMO_START, demoNow, fmtCount, fmtDay, fmtTime, fmtWeekday, parseLocal } = await import('../agent/clock')
const { capStatus, defaultModeId, fmtSeconds, toolView, whenOf } = await import('../state/derive')
const { checkField } = await import('../screens/settings/content')

// Two screen-local formatters, copied as they are today (C1 moves both into format.ts):
/** src/screens/Usage.tsx:15, the Usage page's amounts. */
const usageMoney = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** src/screens/settings/content.ts:206, the Settings rows "Monthly cap" and "Spent so far". */
const settingsCap = (cap: number) => `$${cap}`
const settingsSpent = (spent: number) => `$${spent.toFixed(2)}`
/** src/screens/Usage.tsx:64-73, the sentence under the month's amount and the note beside the cap bar, as they are today. */
const usageHeader = (m: { total: number; cap: number; alertAt: number; daily: number[] }, thisMonth: boolean, reached: boolean) => {
  const { total, daily: days } = m
  const pct = Math.min(100, Math.round(total / m.cap * 100)) + '%'
  const over = total > m.cap
  const cap = thisMonth && reached
  const hint = !thisMonth
    ? over ? `Went over your $${fmtCount(m.cap)} cap` : `Finished under your $${fmtCount(m.cap)} cap`
    : cap
      ? `Cap reached with ${30 - days.length} days of the month left`
      : `On track for about $${fmtCount(Math.round(total / days.length * 30))} this month, ${total / days.length * 30 > m.cap ? 'over' : 'under'} your cap`
  const capNote = !thisMonth
    ? over ? `Closed at ${Math.round(total / m.cap * 100)}% of the cap.` : `Closed at ${pct} of the cap. Nothing was paused.`
    : cap
      ? 'Cap reached today. Routines and jobs are paused until an admin raises it.'
      : `Admins get an email at ${m.alertAt}%. Your Inhouse agent pauses routines and jobs at the cap.`
  return { hint, capNote }
}
/** src/overlays/TraceWindow.tsx:41 and :103-105, the time axis over the steps. */
const TICK_CANDIDATES = [0.5, 1, 2, 5, 10, 15, 20, 30, 50, 60, 100, 120]
const traceTicks = (D: number) => {
  const stepT = TICK_CANDIDATES.find(c => D / c <= 3.2) ?? 120
  const ticks: string[] = []
  for (let v = 0; v <= D; v += stepT) ticks.push(v === 0 ? '0s' : fmtSeconds(v))
  return ticks
}

const agent = new MockAgent()
const SCENARIO_KEY: Record<Scenario, string> = { Normal: 'normal', 'First day': 'firstDay', Loading: 'loading', 'Tool disconnected': 'toolDisconnected', 'Cap reached': 'capReached' }
/** The data, state and a Ctx for a stage and scenario. */
const at = (stage: Stage, scenario: Scenario) => {
  agent.setDemo({ stage, scenario })
  const data: AgentData = agent.read()
  const st: AgentState = agent.getSnapshot()
  return { data, ctx: { S: (['Watch', 'Act', 'Run'] as const).indexOf(stage) as StageIndex, scenario, agent: st, data } }
}

/** A `put` into `out` that refuses a key written twice. */
const putter = (out: Record<string, string>) => (k: string, v: string) => {
  if (Object.hasOwn(out, k)) throw new Error(`Golden key twice: ${k}`)
  out[k] = v
}

/** The variants of the stage sections, each with the tag its keys carry. */
const VARIANTS: [Stage, Scenario, string][] = [['Watch', 'Normal', 'watch'], ['Run', 'Normal', 'run'], ['Act', 'First day', 'firstDay'], ['Watch', 'First day', 'watch.firstDay']]

/** The strings that change with the stage and scenario: chats, Library, Activity, the audit log, the bell, problems, tools and routines. */
function stageSections(stage: Stage, scenario: Scenario): Record<string, string> {
  const out: Record<string, string> = {}
  const put = putter(out)
  const { data, ctx } = at(stage, scenario)

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

  // ---------- routines: the schedule, the next run and the last run
  for (const r of data.routines) {
    put(`routines.${r.id}.time`, r.time)
    put(`routines.${r.id}.when`, whenOf(r))
    put(`routines.${r.id}.next`, r.next)
    if (r.last !== undefined) put(`routines.${r.id}.last`, r.last)
  }
  return out
}

/** The answer bar under an answer given in this session (src/screens/Chats.tsx:280): mode, steps, time taken and when. */
const answerBar = (data: AgentData, trace: Trace, at: number) => {
  const modelLabel = data.models.find(x => x.id === defaultModeId(data, agent.getSnapshot().settings))?.label
  return [modelLabel, `${trace.steps.length - 1} steps`, fmtSeconds(trace.duration), fmtTime(new Date(at))].filter(Boolean).join(' · ')
}

/** Asks for a routine in a chat and returns the card it made, with the answer bar's text as the store stamps it. */
async function askRoutine(chatId: string, q: string): Promise<{ routine: RoutineCard; bar: string }> {
  const events: RunEvent[] = []
  const bars: string[] = []
  const run = (async () => {
    for await (const ev of agent.ask(q, { chatId })) {
      events.push(ev)
      // The store stamps an answer with the demo clock when its part arrives (store.ts:699,719).
      if (ev.type === 'part') {
        const trace = agent.getTrace(ev.trace)
        if (!trace) throw new Error(`No trace ${ev.trace}`)
        bars.push(answerBar(agent.read(), trace, demoNow(agent.getSnapshot().demoStartedAt).getTime()))
      }
    }
  })()
  await vi.runAllTimersAsync()
  await run
  const i = events.findIndex(ev => ev.type === 'part' && ev.part.type === 'routine')
  const ev = events[i]
  if (!ev || ev.type !== 'part' || ev.part.type !== 'routine') throw new Error(`"${q}" made no routine`)
  return { routine: ev.part.routine, bar: bars[bars.length - 1] }
}

/** Requests that make a routine, each with its own schedule, asked on the demo clock at 8:00 AM (start) or later. */
const ROUTINE_ASKS: [string, number][] = [
  ['Every Monday at 7, list products under 3 weeks of stock', 0],
  ['Every Friday at 4:30pm send me the refund numbers', 0],
  ['Every weekday at 9am check the stuck orders', 0],
  ['Every morning at 7:45 check the inventory', 0],
  ['Every Sunday at midnight archive the old drafts', 0],
  ['Daily at noon summarize the Shopify sales', 150],
  ['Every weekday at 10am chase the late suppliers', 150],
  ['Daily at noon post the sales to Slack', 300],
]

async function capture(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const put = putter(out)

  // ---------- the demo clock: what every stamp (approved, set aside, paused, Run now, a chat started) is written with
  put('clock.start.time', fmtTime(DEMO_START))
  put('clock.start.day', fmtDay(DEMO_START))
  put('clock.start.weekday', fmtWeekday(DEMO_START))
  put('clock.latest.time', fmtTime(DEMO_LATEST))
  put('clock.plus3min.time', fmtTime(demoNow(0, 3 * 60_000)))
  put('clock.plus1h59.time', fmtTime(demoNow(0, 119 * 60_000)))

  // ---------- the stage sections: Act on a normal day in full, then each variant where it differs
  const base = stageSections('Act', 'Normal')
  for (const [k, v] of Object.entries(base)) put(k, v)
  for (const [stage, scenario, tag] of VARIANTS) {
    for (const [k, v] of Object.entries(stageSections(stage, scenario))) if (base[k] !== v) put(`${k}@${tag}`, v)
  }

  // ---------- Tools: the disconnected scenario
  const disc = at('Act', 'Tool disconnected')
  const lost = disc.data.scenarios.toolDisconnected
  put('scenarios.toolDisconnected.at', lost.at)
  put(`scenarios.toolDisconnected.${lost.tool}.statusText`, toolView(disc.ctx, lost.tool).statusText)
  put(`scenarios.toolDisconnected.${lost.tool}.lastRead`, toolView(disc.ctx, lost.tool).lastRead)

  // ---------- traces: cost, how long the run and each step took
  const traceLines = (prefix: string, t: Trace) => {
    put(`${prefix}.cost`, t.cost)
    put(`${prefix}.duration`, fmtSeconds(t.duration))
    t.steps.forEach((s, i) => put(`${prefix}.steps.${i}`, fmtSeconds(s.end - s.start)))
    // The trace window (src/overlays/TraceWindow.tsx:105,154,193-194): the axis, a failed step on a phone and on a
    // computer, and the top row with the run's cost.
    put(`${prefix}.ticks`, traceTicks(t.duration).join(' | '))
    t.steps.forEach((s, i) => {
      if (s.kind === 'fail') {
        put(`${prefix}.steps.${i}.phone`, 'Failed after ' + fmtSeconds(Math.max(0, s.end - s.start)))
        put(`${prefix}.steps.${i}.row`, 'failed after ' + fmtSeconds(Math.max(0, s.end - s.start)))
      }
      if (s.kind === 'root') put(`${prefix}.steps.${i}.row`, fmtSeconds(s.end - s.start) + ' · ' + t.cost)
    })
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
  for (const sc of ['Normal', 'Cap reached', 'First day'] as const) {
    const u = at('Act', sc)
    const status = capStatus(u.ctx)
    const s = SCENARIO_KEY[sc]
    put(`usage.${s}.capBanner`, status.bannerText)
    put(`usage.${s}.settings.cap`, settingsCap(u.data.usage.cap))
    put(`usage.${s}.settings.spent`, settingsSpent(status.spent))
    for (const m of u.data.usageMonths) {
      const k = `usage.${s}.${m.month}`
      const thisMonth = m === u.data.usageMonths[0]
      const head = usageHeader(thisMonth ? { ...m, cap: status.cap, alertAt: status.alertAt } : m, thisMonth, status.reached)
      put(`${k}.hint`, head.hint)
      put(`${k}.capNote`, head.capNote)
      put(`${k}.card`, `${usageMoney(m.total)} of $${fmtCount(m.cap)}`)
      put(`${k}.capHint`, `$${fmtCount(m.cap)}`)
      put(`${k}.projection`, `$${fmtCount(Math.round(m.total / m.daily.length * 30))}`)
      put(`${k}.peak`, usageMoney(Math.max(...m.daily)))
      m.daily.forEach((v, i) => put(`${k}.daily.${i}`, usageMoney(v)))
      for (const [tab, rows] of Object.entries(m.breakdown)) rows.forEach((r, i) => put(`${k}.${tab}.${i}`, usageMoney(r.dollars)))
    }
  }

  // ---------- Settings: a money field as typed, as saved or the message under it (src/screens/settings/content.ts:45-56)
  for (const raw of ['300', '$300', ' 320 ', '1,200', '$1,200.5', '300.50', '0.5', '100000', '100,001', '0', '1e3', '-5', '12.345']) {
    const r = checkField('money', raw)
    put(`settings.money.${JSON.stringify(raw)}`, 'value' in r ? r.value : `error: ${r.error}`)
  }

  // ---------- routines made in a chat: the card, the Routines page row and the answer bar, on the demo clock
  at('Act', 'Normal')
  await agent.createChat({ id: 'golden', title: 'Golden' })
  const t0 = Date.now()
  for (const [i, [q, afterMin]] of ROUTINE_ASKS.entries()) {
    vi.setSystemTime(Math.max(Date.now(), t0 + afterMin * 60_000))
    const { routine, bar } = await askRoutine('golden', q)
    const k = `created.${i}`
    put(`${k}.ask`, q)
    put(`${k}.card.time`, routine.time)
    put(`${k}.card.when`, whenOf(routine))
    put(`${k}.card.next`, routine.next)
    put(`${k}.answerBar`, bar)
    // The Routines page lists a routine made in a chat from the agent's state (src/screens/Routines.tsx:29).
    const row = agent.getSnapshot().routinesExtra.find(r => r.id === routine.id)
    if (!row) throw new Error(`Routine ${routine.id} isn't on the Routines page`)
    put(`${k}.routines.time`, row.time)
    put(`${k}.routines.when`, whenOf(row))
    put(`${k}.routines.next`, row.next)
  }
  // The chat the person starts, listed with the demo clock's time (store.ts:313).
  put('created.chatListAt', fmtTime(demoNow(agent.getSnapshot().demoStartedAt)))

  at('Act', 'Normal')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/** The file as JSON with no-break spaces written as `\u00a0`, so a reader sees where the UI keeps a time on one line. */
const serialize = (x: Record<string, string>) => JSON.stringify(x, null, 2).replaceAll('\u00a0', '\\u00a0') + '\n'

test("the golden file holds what today's code shows for every time, amount, schedule and duration in the sample data", async () => {
  // Fake timers so the routine requests answer at once; the demo clock moves only as the test sets it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  try {
    await expect(serialize(await capture())).toMatchFileSnapshot('./format.golden.json')
  } finally {
    vi.useRealTimers()
  }
})
