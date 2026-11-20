// The differential test of C1 (P1): the golden file holds every display string the UI showed before C1, for every sample
// value that is an instant, an amount, a schedule time or a duration, captured from the code before any formatter
// changed (PR #58). The keys name where the string shows. This test writes the same strings with the C1 formatters in
// format.ts, fed the new `{ iso, ms }`, `{ minor, currency }`, `{ hour, minute }` and ms values, and checks they equal
// the file exactly. The file is never rewritten: a string that differs is a change on screen.
// The strings that change with the stage or the scenario (chats, Library, Activity, the audit log, the bell, problems,
// tools and routines) are captured in Act on a normal day, then again in Watch, in Run and on the First day: a variant
// is written as `<key>@<variant>` only where its string differs from Act's or Act has no such key.
import { expect, test, vi } from 'vitest'
import tracesJson from '@sample/traces.json'
import golden from './format.golden.json'
import type { AgentData, AgentState, Instant, RoutineCard, RunEvent, Scenario, Stage, StageIndex, Trace } from '../agent/types'

// The mock reads and writes localStorage when it starts: an empty one in memory, so it starts fresh and quietly.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
// The client entry first: display.ts reads the clock from it, and the entry builds the mock, which imports display (a cycle that
// only works when the entry starts it).
await import('../agent')
const { MockAgent } = await import('../agent/mock')
const { instantOf } = await import('./format')
const { DEMO_LATEST, DEMO_START, demoNow } = await import('../agent/demo-clock')
const { capStatus, defaultModeId, lastRunLine, sinceLine, toolView, usageSummary, whenOf } = await import('../state/derive')
const { checkField } = await import('../screens/settings/content')
const F = await import('./format')
const { display, nowOf } = await import('../state/display')
const d = display()

/** Now on the demo clock: what relative labels ("Today", "Yesterday") are measured from. */
const now = () => nowOf(agent.getSnapshot())
// Each call site's own helper from format.ts, so this checks the code the screen runs: fmtUsageMoney and fmtSpentOfCap
// (src/screens/Usage.tsx), fmtNextRun (src/screens/chat/Parts.tsx), fmtAuditDay, fmtCapSetting and fmtSpentSetting
// (src/screens/settings/content.ts), traceTicks (src/overlays/TraceWindow.tsx) and fmtAnswerBar (src/screens/Chats.tsx).
const usageMoney = (major: number) => F.fmtUsageMoney(major, 'USD', d)

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
    put(`chats.${c.id}.at`, F.fmtWhen(c.at, now(), d))
    put(`chats.${c.id}.day`, F.fmtDayGroup(c.at, now(), d))
    c.turns.forEach((t, ti) => {
      if (t.role !== 'agent') return
      t.parts.forEach((p, pi) => {
        const k = `chats.${c.id}.turn${ti}.part${pi}`
        if (p.type === 'workRow') put(`${k}.time`, F.fmtTime(p.at, d))
        if (p.type === 'routine') {
          put(`${k}.routine.time`, F.fmtClock(p.routine.time, d))
          put(`${k}.routine.when`, whenOf(p.routine))
          put(`${k}.routine.next`, F.fmtNextRun(p.routine.next, d))
        }
      })
    })
  }

  // ---------- Library: the card's date, the viewer's Date row and a media file's length
  for (const f of agent.listFiles()) {
    put(`library.${f.id}.date`, F.fmtWhen(f.at, now(), d))
    put(`library.${f.id}.viewerDate`, F.fmtWeekdayTime(f.at, d))
    if (f.durationMs !== undefined) put(`library.${f.id}.duration`, F.fmtMediaLength(f.durationMs, d))
  }

  // ---------- Activity's fixed lines and the audit log
  data.activity.today.forEach((l, i) => put(`activity.today.${i}.t`, F.fmtTime(l.at, d)))
  data.activity.earlier.forEach((l, i) => {
    put(`activity.earlier.${i}.day`, F.fmtWeekday(l.at, d))
    put(`activity.earlier.${i}.t`, F.fmtTime(l.at, d))
  })
  data.auditLog.forEach((e, i) => {
    put(`audit.${i}.day`, F.fmtAuditDay(e.at, now(), d))
    put(`audit.${i}.at`, F.fmtWhen(e.at, now(), d))
  })

  // ---------- the bell
  for (const n of agent.listNotifications()) put(`notifications.${n.id}.at`, F.fmtWhen(n.at, now(), d))

  // ---------- problems: the amount on the card and when the draft was made
  for (const p of data.problems) {
    put(`problems.${p.id}.cost`, F.fmtMoney(p.cost, d))
    put(`problems.${p.id}.draftedAt`, F.fmtTime(p.draftedAt, d))
  }

  // ---------- tools and channels: connected since, last read, going live
  for (const key of Object.keys(data.tools.details)) {
    const v = toolView(ctx, key)
    put(`tools.${key}.since`, sinceLine(data.tools.details[key], d))
    put(`tools.${key}.listLine`, v.listLine)
    put(`tools.${key}.connectedRow`, v.connectedRow)
    put(`tools.${key}.lastRead`, v.lastRead)
  }
  for (const c of data.tools.channels) put(`channels.${c.key}.since`, F.fmtDay(c.since, d))

  // ---------- routines: the schedule, the next run and the last run
  for (const r of data.routines) {
    put(`routines.${r.id}.time`, F.fmtClock(r.time, d))
    put(`routines.${r.id}.when`, whenOf(r))
    put(`routines.${r.id}.next`, F.fmtWeekdayAt(r.next, d))
    if (r.last !== undefined) put(`routines.${r.id}.last`, lastRunLine(r.last, now()))
  }
  return out
}

/** The answer bar under an answer given in this session (src/screens/Chats.tsx): mode, steps, time taken and when. */
const answerBar = (data: AgentData, trace: Trace, at: Instant) => {
  const model = data.models.find(x => x.id === defaultModeId(data, agent.getSnapshot().settings))?.label
  return F.fmtAnswerBar({ model, steps: trace.steps.length - 1, durationMs: trace.durationMs, at }, d)
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
        bars.push(answerBar(agent.read(), trace, instantOf(now())))
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
  put('clock.start.time', F.fmtTime(DEMO_START.getTime(), d))
  put('clock.start.day', F.fmtDay(DEMO_START.getTime(), d))
  put('clock.start.weekday', F.fmtWeekday(DEMO_START.getTime(), d))
  put('clock.latest.time', F.fmtTime(DEMO_LATEST.getTime(), d))
  put('clock.plus3min.time', F.fmtTime(demoNow(0, 3 * 60_000).getTime(), d))
  put('clock.plus1h59.time', F.fmtTime(demoNow(0, 119 * 60_000).getTime(), d))

  // ---------- the stage sections: Act on a normal day in full, then each variant where it differs
  const base = stageSections('Act', 'Normal')
  for (const [k, v] of Object.entries(base)) put(k, v)
  for (const [stage, scenario, tag] of VARIANTS) {
    for (const [k, v] of Object.entries(stageSections(stage, scenario))) if (base[k] !== v) put(`${k}@${tag}`, v)
  }

  // ---------- Tools: the disconnected scenario
  const disc = at('Act', 'Tool disconnected')
  const lost = disc.data.scenarios.toolDisconnected
  put('scenarios.toolDisconnected.at', F.fmtTime(lost.at, d))
  put(`scenarios.toolDisconnected.${lost.tool}.statusText`, toolView(disc.ctx, lost.tool).statusText)
  put(`scenarios.toolDisconnected.${lost.tool}.lastRead`, toolView(disc.ctx, lost.tool).lastRead)

  // ---------- traces: cost, how long the run and each step took
  const traceLines = (prefix: string, t: Trace) => {
    const cost = F.fmtMoney(t.cost, d, { cents: 'always' })
    put(`${prefix}.cost`, cost)
    put(`${prefix}.duration`, F.fmtDuration(t.durationMs, d))
    t.steps.forEach((s, i) => put(`${prefix}.steps.${i}`, F.fmtDuration(s.endMs - s.startMs, d)))
    // The trace window (src/overlays/TraceWindow.tsx): the axis, a failed step on a phone and on a computer, and the top
    // row with the run's cost.
    put(`${prefix}.ticks`, F.traceTicks(t.durationMs, d).map(k => k.label).join(' | '))
    t.steps.forEach((s, i) => {
      if (s.kind === 'fail') {
        put(`${prefix}.steps.${i}.phone`, 'Failed after ' + F.fmtDuration(Math.max(0, s.endMs - s.startMs), d))
        put(`${prefix}.steps.${i}.row`, 'failed after ' + F.fmtDuration(Math.max(0, s.endMs - s.startMs), d))
      }
      if (s.kind === 'root') put(`${prefix}.steps.${i}.row`, F.fmtDuration(s.endMs - s.startMs, d) + ' · ' + cost)
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
    // src/screens/settings/content.ts: the Settings rows "Monthly cap" (a field's value) and "Spent so far".
    put(`usage.${s}.settings.cap`, F.fmtCapSetting(u.data.usage.cap, d))
    put(`usage.${s}.settings.spent`, F.fmtSpentSetting(status.spent, d))
    for (const m of u.data.usageMonths) {
      const k = `usage.${s}.${m.month}`
      const thisMonth = m === u.data.usageMonths[0]
      const head = usageSummary(thisMonth ? { ...m, cap: status.cap, alertAt: status.alertAt } : m, thisMonth, thisMonth && status.reached)
      const total = F.majorOf(m.total), daily = m.daily.map(F.majorOf)
      put(`${k}.hint`, head.hint)
      put(`${k}.capNote`, head.capNote)
      put(`${k}.card`, F.fmtSpentOfCap(m.total, m.cap, d))
      put(`${k}.capHint`, F.fmtMoney(m.cap, d))
      put(`${k}.projection`, F.fmtMoney(F.moneyOf(Math.round(total / daily.length * 30), m.total.currency), d))
      put(`${k}.peak`, usageMoney(Math.max(...daily)))
      daily.forEach((v, i) => put(`${k}.daily.${i}`, usageMoney(v)))
      for (const [tab, rows] of Object.entries(m.breakdown)) rows.forEach((r, i) => put(`${k}.${tab}.${i}`, usageMoney(F.majorOf(r.spent))))
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
    put(`${k}.card.time`, F.fmtClock(routine.time, d))
    put(`${k}.card.when`, whenOf(routine))
    put(`${k}.card.next`, F.fmtNextRun(routine.next, d))
    put(`${k}.answerBar`, bar)
    // The Routines page lists a routine made in a chat from the agent's state (src/screens/Routines.tsx:29).
    const row = agent.getSnapshot().routinesExtra.find(r => r.id === routine.id)
    if (!row) throw new Error(`Routine ${routine.id} isn't on the Routines page`)
    put(`${k}.routines.time`, F.fmtClock(row.time, d))
    put(`${k}.routines.when`, whenOf(row))
    put(`${k}.routines.next`, F.fmtNextRun(row.next, d))
  }
  // The chat the person starts, stamped on the demo clock (store.ts) and listed by src/ui/chat.tsx.
  put('created.chatListAt', F.fmtWhen(instantOf(now()), now(), d))

  at('Act', 'Normal')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

test('the C1 formatters write exactly the golden strings for every time, amount, schedule and duration in the sample data', async () => {
  // Fake timers so the routine requests answer at once; the demo clock moves only as the test sets it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  try {
    const out = await capture()
    expect(Object.keys(out).length).toBe(681)
    expect(out).toEqual(golden)
  } finally {
    vi.useRealTimers()
  }
})
