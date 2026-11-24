// What the demo agent answers with: the scripted replies, and the reading of a request for a routine or a skill. It loads with
// the first run (mock-chat.ts), not with the page: Today's JS budget (scripts/check-bundle.mjs) has no room for it.
import { chatScript, clockTimeOf, problems, seedTable } from './data'
import { demoNow, nextLocalRun } from './demo-clock'
import { listNames } from '../state/derive'
import type { RoutineCard, SeedTurn, SkillCard, SkillDef, ToolsData, MessagePart, Instant, ChatThread, AgentState, AgentData, DemoContext } from './types'
import type { Script, RunInfo } from './mock'
import type { TraceKey } from './data'
import { stageIndex } from './types'

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
/** A question as typed, for matching a seeded one: case, spaces and the closing punctuation don't count. */
const norm = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '')

/** What the scripts take from the mock: its state and data, and the few things it keeps for them. */
export interface ScriptHost {
  demo: DemoContext
  state: AgentState
  startedAt: number
  runInfo: Map<string, RunInfo>
  k: { chats: ChatThread[]; tools: ToolsData; traceKey(t: string): TraceKey; meName(): string; changeSkill(name: string): void }
  read(): AgentData
  commit(next: Partial<AgentState>): boolean
}

// ---------- request parsing for scripted routine and skill replies ----------

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** A clock time read from a request: hours 0 to 23 and minutes. */
type Clock = { h: number; m: number }
/** Words that may follow a bare "at 7" when it is a time ("at 7 every day"), unlike "at 3 weeks of stock". A full stop
 * counts only when no digit follows ("at 9.30" is not 9 o'clock). */
const AFTER_BARE = "(?=\\s*(?:$|[,;:!?]|\\.(?!\\d)|(?:on|every|each|and|to|in|for|with|the|o['\u2019]clock|sharp|daily|weekly|tomorrow|tonight|morning|evening|night|afternoon)\\b))"
const DAY_WORD = '(?:mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?|day|morning|evening|night|afternoon|week|weekdays?)'
const WEEKDAY = '(?:mon|tues|wednes|thurs|fri|satur|sun)days?'
const PART_OF_DAY = '(?:morning|afternoon|evening|night)'
/** "every Monday", "each weekday", "daily": the phrase that makes a request a schedule. */
const SCHEDULE_PHRASE = `(?:(?:every|each)\\s+${DAY_WORD}|daily|weekly)`
/** The days a schedule runs on: "every Monday", "each Tuesday and Thursday", "every week on Friday", "weekly on Friday".
 *  A weekday the task names ("send the Friday numbers") isn't one. */
const SCHEDULE_DAYS = new RegExp(`\\b(?:(?:every|each)\\s+(?:week,?\\s+on\\s+)?|weekly,?\\s+on\\s+)${WEEKDAY}(?:\\s*(?:,|and|&|or)\\s*(?:(?:every|each|on)\\s+)?${WEEKDAY})*`, 'gi')
/** The schedule phrase straight before its time, with a day or a part of the day between ("every week on Monday at 9",
 *  "every Monday morning at 6"). */
const SCHEDULE_LEAD = new RegExp(`\\b${SCHEDULE_PHRASE}(?:\\s+on\\s+${WEEKDAY})?(?:\\s+(?:in\\s+the\\s+)?${PART_OF_DAY})?,?\\s+(?=at\\s)`, 'i')
/** Counts that follow a number and make it not an hour: "at 3 weeks of stock", "at 2 SKUs", "at 10 minutes past 9". */
const NOT_AN_HOUR = '(?!\\s*(?:%|(?:weeks?|days?|hours?|minutes?|units?|orders?|items?|skus?|products?|pieces?|percent|times|of)\\b))'
/** The time straight after the schedule phrase. A bare "at N" is a time whatever word follows ("Every morning at 6
 *  summarize refunds"), unless a count does ("every Monday at 3 orders late") or it goes on as a number ("at 9.30"). */
const LEAD_FORMS: [RegExp, 'ampm' | 'clock' | 'bare'][] = [
  [/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![a-z])/i, 'ampm'],
  [/^at\s+(\d{1,2}):(\d{2})\b/, 'clock'],
  [new RegExp(`^at\\s+(\\d{1,2})(?![\\d:]|\\.\\d)${NOT_AN_HOUR}`, 'i'), 'bare'],
]
const TIME_FORMS: [RegExp, 'ampm' | 'clock' | 'bare'][] = [
  [/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![a-z])/i, 'ampm'],
  [/\b(\d{1,2}):(\d{2})\b/, 'clock'],
  [new RegExp(`\\bat\\s+(\\d{1,2})${AFTER_BARE}`, 'i'), 'bare'],
]
/** A part of the day right after the time ("at 7 in the evening", "at 9 tonight"). */
const PART_AFTER = /^\s*(?:in\s+the\s+)?(?:mornings?|afternoons?|evenings?|nights?|tonight)\b/i
/** A time a form matched, or null when it can't be one ("at 25", "7:75", "13pm"). `ctx` is the text whose part of the day counts. */
const clockOf = (m: RegExpExecArray, form: 'ampm' | 'clock' | 'bare', ctx: string): Clock | null => {
  let h = Number(m[1])
  const min = form === 'bare' ? 0 : Number(m[2] ?? 0)
  if (min > 59) return null
  if (form === 'ampm') {
    if (h < 1 || h > 12) return null
    const pm = m[3].toLowerCase() === 'pm'
    return { h: (h % 12) + (pm ? 12 : 0), m: min }
  }
  if (h > 23 || (form === 'bare' && (h < 1 || h > 12))) return null
  if (h <= 12) {
    if (/\bmornings?\b/i.test(ctx)) h %= 12
    else if (/\b(afternoons?|evenings?|nights?|tonight)\b/i.test(ctx)) h = h === 12 && /\b(evenings?|nights?|tonight)\b/i.test(ctx) ? 0 : (h % 12) + 12
    else if (h >= 1 && h <= 6) h += 12
  }
  return { h, m: min }
}
/**
 * The time a request names, or null when it names none or one that can't be ("at 25", "7:75", "13pm"): the agent then
 * asks for the time. The time straight after the schedule phrase wins over later times in the task ("every day at 7 list
 * what sold at 6"), and only its own part of the day counts. Morning means AM; afternoon, evening and night mean PM.
 * Otherwise a bare hour from 1 to 6 is PM ("at 4" is 4:00 PM) and from 7 to 11 AM. "16:00" is read as 24-hour.
 */
const timeIn = (q: string): Clock | null => {
  const lead = SCHEDULE_LEAD.exec(q)
  if (lead) {
    const rest = q.slice(lead.index + lead[0].length)
    for (const [re, form] of LEAD_FORMS) {
      const m = re.exec(rest)
      if (m) return clockOf(m, form, lead[0] + (PART_AFTER.exec(rest.slice(m[0].length))?.[0] ?? ''))
    }
  }
  for (const [re, form] of TIME_FORMS) {
    const m = re.exec(q)
    if (m) return clockOf(m, form, q)
  }
  if (/\bnoon\b/i.test(q)) return { h: 12, m: 0 }
  if (/\bmidnight\b/i.test(q)) return { h: 0, m: 0 }
  return null
}

/** The next run on the demo clock, after now. */
const nextRun = (freq: string, day: string, at: Clock, now: Date): Instant =>
  nextLocalRun(at.h, at.m, now, wd => (freq === 'Weekly' ? WEEKDAYS[(wd + 6) % 7] === day : day !== 'Weekdays' || (wd > 0 && wd < 6)))

/** A name from a request's first words, with the person's own capitals (product and tool names stay as typed). */
const shortName = (clause: string, fallback: string) => {
  const words = clause.replace(/[.?!]+$/, '').split(/\s+/).filter(Boolean).slice(0, 4)
  return words.length ? cap1(words.join(' ')) : fallback
}

/** The schedule and time phrases in a request, wherever they are, so what's left names the routine. */
const NOT_THE_NAME = [
  /^\s*(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:remind\s+me\s+(?:to\s+)?)?/i,
  // "every Monday morning": the part of the day goes with the schedule.
  new RegExp(`\\b(?:on\\s+)?(?:(?:every|each)\\s+${DAY_WORD}|daily|weekly|weekdays?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?)\\b(?:\\s+(?:in\\s+the\\s+)?${PART_OF_DAY}\\b)?`, 'gi'),
  /\b(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)(?![a-z])(?:\s*(?:o['\u2019]clock|sharp)\b)?/gi,
  /\bat\s+\d{1,2}(?::\d{2})?\b(?:\s*(?:o['\u2019]clock|sharp)\b)?/gi,
  /\b(?:at\s+)?(?:noon|midnight)\b(?:\s*sharp\b)?/gi,
  /\bin the (?:morning|afternoon|evening)\b/gi,
  /\bplease\b/gi,
]
const nameOf = (q: string) => {
  // A name is a few words: past 500 characters is never needed, and keeps the trims below quick on a long paste.
  let rest = q.slice(0, 500)
  for (const re of NOT_THE_NAME) rest = rest.replace(re, ' ')
  rest = rest.replace(/\s+/g, ' ').replace(/^[\s,;:.-]+|[\s,;:.?!-]+$/g, '').replace(/^(?:and|to|then)\s+/i, '')
  return shortName(rest, 'New routine')
}

/** A routine from a request, or null when it doesn't say the day and time clearly enough: the agent asks for them. */
function routineFromRequest(q: string, stage: number, id: string, now: Date): RoutineCard | null {
  const script = chatScript.scripted.find(x => x.match.startsWith('every|'))! as unknown as { example: { ask: string; routine: { name: string; freq: string; day: string; time: string } }; ActRun: { type: string; note?: Record<string, string> }[] }
  const notes = script.ActRun.find(x => x.type === 'routine')?.note
  if (!notes) throw new Error('chat-script.json: the routine reply has no routine part with notes.')
  const note = stage === 2 ? notes.Run : notes.Act
  let name: string, freq: string, day: string, at: Clock | null
  if (q.trim().toLowerCase() === script.example.ask.toLowerCase()) {
    let time: string
    ;({ name, freq, day, time } = script.example.routine)
    const t = clockTimeOf('the example routine in chat-script.json', time)
    at = { h: t.hour, m: t.minute }
  } else {
    // Only the days the schedule names: "every Monday at 9 send the Friday numbers" runs on Monday.
    const named = [...q.matchAll(SCHEDULE_DAYS)].map(x => x[0]).join(' ')
    const weekdays = WEEKDAYS.filter(d => new RegExp(`\\b${d}s?\\b`, 'i').test(named))
    const weekday = weekdays[0]
    // "every Tuesday and Thursday": a routine runs on one day of the week, so the agent asks rather than pick one.
    if (weekdays.length > 1) return null
    if (/\bweekdays?\b/i.test(q)) { freq = 'Daily'; day = 'Weekdays' }
    else if (weekday) { freq = 'Weekly'; day = weekday }
    else if (/\b(daily|every day|each day|every (morning|evening|night|afternoon)|each (morning|evening|night|afternoon))\b/i.test(q)) { freq = 'Daily'; day = 'Every day' }
    // "Weekly" with no day: the agent asks rather than picking Monday.
    else return null
    at = timeIn(q)
    name = nameOf(q)
  }
  if (!at) return null
  return { id, name, freq, day, time: { hour: at.h, minute: at.m }, next: nextRun(freq, day, at, now), note, what: q }
}

// A routine is made only from a request (not a question) with a schedule and a time. "How much did we refund each customer
// last week?" is a plain question; "Remind me every Friday" gets asked for a time and makes nothing yet. A polite request
// ("Can you email me daily at 9am?") is a request, question mark or not.
const QUESTION_WORD = /^(how|what|which|why|when|where|who|whom|whose|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|any)\b/i
const POLITE = /^(?:(?:can|could|would|will)\s+you\b|please\b)/i
/** A polite opener that asks to be told something is a question, schedule words or not ("Can you explain how routines run every morning?"). */
const ASKS_TO_BE_TOLD = /^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:explain|tell\s+me\s+why|show\s+me\s+how)\b/i
const SCHEDULE = new RegExp(`\\b(?:(?:every|each)\\s+${DAY_WORD}|daily|weekly)\\b`, 'i')
/** A request, not a question: no question mark and no question word first, unless it opens with "can you" or "please". */
const isRequest = (q: string) => !ASKS_TO_BE_TOLD.test(q.trim()) && (POLITE.test(q.trim()) || (!q.includes('?') && !QUESTION_WORD.test(q.trim())))
const isScheduleRequest = (q: string) => isRequest(q) && SCHEDULE.test(q)
const ASK_FOR_TIME = 'What time should it run? Tell me the day and the time, like "every Friday at 9\u00a0AM", and I\'ll set it up.'

function skillFromRequest(q: string, stage: number, tools: ToolsData): SkillCard {
  const modes = (chatScript.scripted.find(x => x.match.endsWith('skill'))! as unknown as { reply: { type: string; mode?: Record<string, string> }[] }).reply.find(x => x.type === 'skill')?.mode
  if (!modes) throw new Error('chat-script.json: the skill reply has no skill part with modes.')
  // A skill's name and description are a few words: past 500 characters is never needed, and keeps the trim below quick on a long paste.
  const m = /\bskill\b\s*(?:that|to|which|for|who)?\s*(.*)$/i.exec(q.slice(0, 500))
  // "Can you build a skill?" names nothing after the word: the description is the request itself, never a lone ".".
  const rest = (m?.[1] ?? '').replace(/[\s.?!]+$/, '').trim()
  const desc = rest ? cap1(`${rest}.`) : q
  const toolNames = Object.values(tools.details).map(d => d.name).filter(n => new RegExp(`\\b${n}\\b`, 'i').test(q))
  return {
    name: shortName(rest, 'New skill'),
    desc,
    tools: toolNames.length ? toolNames.join(' · ') : 'Shopify',
    mode: ['Watch', 'Act', 'Run'].map(s => modes[s])[stage],
  }
}

// ---------- a formatted answer (code block, wide table, list, quote, link) ----------

/** Asked for a query or formula, the agent answers in markdown: the one sample answer with a code block and a wide table. */
const QUERY_ASK = /\b(sql|query|formula)\b/i
const QUERY_ANSWER = [
  "Here's the query I ran on **Shopify** for last week (Nov 7 to 13), grouped by SKU:",
  '',
  '```sql',
  'SELECT sku, product, SUM(quantity) AS units, SUM(total_price) AS sales, COUNT(refund_id) AS refunds',
  'FROM orders',
  "WHERE created_at BETWEEN '2026-11-07' AND '2026-11-13'",
  'GROUP BY sku, product',
  'ORDER BY units DESC;',
  '```',
  '',
  '### Last week by SKU',
  '',
  '| SKU | Product | Units | Sales | Average order | Refunds | Channel | Best day |',
  '|---|---|---|---|---|---|---|---|',
  '| CB-750-OL | Cairn Insulated Bottle, Olive | 126 | $3,150 | $25.00 | 2 | Shopify | Thu, Nov 12 |',
  '| SF-M-BLK | Summit Fleece, Black, M | 94 | $7,990 | $85.00 | 3 | Shopify | Sat, Nov 7 |',
  '| TS-L-NAV | Trail Shell Jacket, Navy, L | 71 | $16,898 | $238.00 | 4 | Shopify | Sun, Nov 8 |',
  '',
  '- **Cairn Insulated Bottle** sold the most units.',
  '- Refunds were `14` in total, about the same as the week before.',
  '1. Copy the query to run it again.',
  '2. Open [Shopify](#/tools/shopify) to see the orders.',
  '',
  "> These are Shopify orders only. [Amazon orders](https://orders.example.test/) aren't in this query.",
].join('\n')

/** A seeded turn's own answer when the question is one a chat already asked: this chat's first, then any chat's. */
export function seeded(h: ScriptHost, q: string, chatId: string): Script | null {
  const stage = h.demo.stage
  const want = norm(q)
  const order = [...h.k.chats.filter(c => c.id === chatId), ...h.k.chats.filter(c => c.id !== chatId)]
  for (const c of order) {
    for (let t = 0; t < c.turns.length; t++) {
      const turn = c.turns[t]
      if (turn.role !== 'user' || norm(turn.text) !== want) continue
      const answers: Extract<SeedTurn, { role: 'agent' }>[] = []
      for (let j = t + 1; j < c.turns.length; j++) {
        const a = c.turns[j]
        if (a.role === 'user') break
        if (!a.stage || a.stage === stage) answers.push(a)
      }
      if (!answers.length) continue
      const fb = chatScript.fallback
      return { thinking: fb.thinking, delayMs: fb.delayMs, trace: h.k.traceKey(answers[0].trace), parts: answers.flatMap(a => a.parts) }
    }
  }
  return null
}

export function buildScript(h: ScriptHost, q: string, chatId: string): Script {
  const S = stageIndex(h.demo.stage)
  const sc = chatScript.scripted
  const pick = (match: string) => {
    const e = sc.find(x => x.match === match)
    if (!e) throw new Error(`chat-script.json has no entry for ${match}`)
    return e
  }
  const fb = chatScript.fallback
  const text = (t: string): MessagePart => ({ type: 'text', text: t })

  // Nothing read yet: even a seeded question gets "I can't see your tools yet" (day one) or "still reading" (loading).
  if (h.demo.scenario === 'First day') {
    return { thinking: fb.thinking, delayMs: fb.delayMs, parts: [text(chatScript.firstDay)], trace: h.k.traceKey(chatScript.firstDayTrace) }
  }
  if (h.demo.scenario === 'Loading') {
    return { thinking: fb.thinking, delayMs: fb.delayMs, parts: [text(chatScript.loading)], trace: h.k.traceKey(chatScript.loadingTrace) }
  }
  const disc = pick('gorgias|ticket|refund|customer service') as { match: string; delayMs: number; reply: { text: string }[]; trace: string }
  if (h.demo.scenario === 'Tool disconnected' && new RegExp(disc.match, 'i').test(q)) {
    return { thinking: fb.thinking, delayMs: fb.delayMs, parts: [{ type: 'error', text: disc.reply[0].text, retryQuestion: q }], trace: h.k.traceKey(disc.trace) }
  }
  // A question a chat already asked gets that chat's own answer (Regenerate on a seeded chat, the suggestions).
  const own = seeded(h, q, chatId)
  if (own) return own
  const more = /^Tell me more about: (.+)$/i.exec(q.trim())
  const p = more && problems.find(x => x.title === more[1].trim())
  if (p) {
    const s = pick('Tell me more about: {problem title}') as { thinking: string[]; delayMs: number }
    const found = p.found.map(([t]) => t).join('')
    return { thinking: s.thinking, delayMs: s.delayMs, trace: 'generic', parts: [text(`${found} Suggested next step: ${p.next}.`)] }
  }
  // A skill's page's "Edit in a chat": the brand's own skill is changed (dated now); ours are the Inhouse team's to change.
  const edit = /^change the "([^"]+)" skill\b/i.exec(q.trim())
  if (edit) {
    const name = edit[1]!
    const skill = [...h.state.skillsExtra, ...h.read().skills].find(s => s.n === name)
    if (skill?.mine) {
      return {
        thinking: ['Reading the skill…', 'Saving the changes…'], delayMs: fb.delayMs, trace: 'generic',
        parts: [text(`Saved the changes to "${name}". Your Inhouse agent uses them from your next chat.`)],
        after: () => h.k.changeSkill(name),
      }
    }
    if (skill) return { thinking: fb.thinking.slice(0, 1), delayMs: fb.delayMs, trace: 'generic', parts: [text(`"${name}" is one of the Inhouse team's skills, so it can't be changed from a chat. I can send them a request to change it.`)] }
  }
  // The same guard as routines: "Any new skill ideas?" is a question, not a request to make one.
  if (isRequest(q) && /\b(create|make|build|add|new|teach)\b.{0,14}\bskill\b/i.test(q)) {
    const s = pick('(create|make|build|add|new|teach) … skill') as { thinking: string[]; delayMs: number; reply: { type: string; text?: string }[]; trace: string }
    const skill = skillFromRequest(q, S, h.k.tools)
    // The answer's footer links its steps, so the reply carries no work row of its own (one link per answer).
    return {
      thinking: s.thinking, delayMs: s.delayMs, trace: h.k.traceKey(s.trace),
      parts: [text(s.reply.find(x => x.type === 'text')!.text!), { type: 'skill', skill }],
      after: (info, replaces) => {
        const def: SkillDef = { n: skill.name, d: skill.desc, icon: 'menu_book', need: 0, by: `${h.k.meName()}, in a chat`, used: 'New today', mine: true }
        // Regenerate or Edit of the question that made a skill updates that skill instead of adding a second.
        const old = replaces ? h.runInfo.get(replaces)?.skill : undefined
        const at = old === undefined ? -1 : h.state.skillsExtra.findIndex(x => x.n === old)
        const skillsExtra = at < 0 ? [def, ...h.state.skillsExtra] : h.state.skillsExtra.map((x, i) => (i === at ? def : x))
        h.commit({ skillsExtra })
        info.skill = def.n
      },
    }
  }
  const r = pick('every|each|daily|weekly|remind|routine|schedule') as { match: string; thinking: string[]; delayMs: number; Watch: { type: string; text: string }[]; ActRun: { type: string; text?: string }[]; trace: string }
  if (isScheduleRequest(q)) {
    if (S === 0) {
      return { thinking: r.thinking, delayMs: r.delayMs, trace: 'generic', parts: [text(r.Watch[0].text), { type: 'notInThisStage', text: r.Watch[1].text }] }
    }
    // A schedule with no time (or no day, or a time that can't be) makes nothing yet: the agent asks.
    const routine = routineFromRequest(q, S, '', demoNow(h.startedAt))
    if (!routine) return { thinking: r.thinking.slice(0, 1), delayMs: fb.delayMs, trace: 'generic', parts: [text(ASK_FOR_TIME)] }
    return {
      thinking: r.thinking, delayMs: r.delayMs, trace: h.k.traceKey(r.trace),
      parts: [text(r.ActRun.find(x => x.type === 'text')!.text!), { type: 'routine', routine }],
    }
  }
  if (/stuck/i.test(q)) {
    const s = pick('stuck') as { thinking: string[]; delayMs: number }
    const seedText = (chatScript.seedThread.turns[1] as { agent: { text?: string }[] }).agent[0].text!
    return { thinking: s.thinking, delayMs: s.delayMs, trace: 'stuck', parts: [text(seedText), { type: 'table', table: seedTable }] }
  }
  if (QUERY_ASK.test(q)) {
    return { thinking: fb.thinking, delayMs: fb.delayMs, trace: 'query', parts: [text(QUERY_ANSWER)] }
  }
  const plain = (match: string, re: RegExp): Script | null => {
    const s = pick(match) as { thinking: string[]; delayMs: number; reply: { text: string }[]; trace: string }
    return re.test(q) ? { thinking: s.thinking, delayMs: s.delayMs, trace: h.k.traceKey(s.trace), parts: [text(s.reply[0].text)] } : null
  }
  // "Black Friday" is checked before "Friday", so the dictated question gets its own answer.
  const scripted = plain('refund', /refund/i) ?? plain('black friday|run out', /black friday|run out/i) ?? plain('friday|feature|email', /friday|feature|email/i)
  if (scripted) return scripted
  // Off-script (decision D8): what the agent can't answer from the tools, then the suggested questions as chips.
  // The tools it can read now: not the one whose login expired.
  const { connection } = h.read().tools
  const readable = listNames(h.k.tools.connected.filter(k => !connection[k]).map(k => h.k.tools.details[k].name))
  return { thinking: fb.thinking, delayMs: fb.delayMs, trace: h.k.traceKey(fb.trace), parts: [text(fb.reply[0].text.replace('{tools}', readable)), { type: 'suggestions', questions: chatScript.suggestions }] }
}

