// Settings content. Pure data: the screen renders it.
import type { AgentData, AgentState, MemoryLine, StageIndex } from '../../agent/types'
import { STAGE_TAGS } from '../../state/derive'
import { EFFORTS, defaultModeId, modeEffortKey, modeOnKey, thinkingModes } from '../../state/derive'
import type { Pop, RequestType } from '../../state/store'
import type { Theme } from '../../lib/theme'
import { DEMO_START, plainSpaces } from '../../agent/clock'

export type RowKind = 'select' | 'text' | 'value' | 'button' | 'toggle' | 'mode' | 'photo'
export interface Row {
  title: string
  desc: string
  kind: RowKind
  value: string
  /** Lowest stage index that includes it. */
  need: number
  /** Toggle key and default. */
  key?: string
  def?: boolean
  onClick?: () => void
  /** The choices of a `select` row. */
  options?: string[]
  /** What a `select` row shows for each saved value, when the value isn't readable itself (a time zone id). */
  labels?: Record<string, string>
  /** A `mode` row: where its on switch is saved, whether it is on, and why it can't be switched off (the tooltip). */
  switchKey?: string
  switchOn?: boolean
  switchTip?: string
  /** A small tag shown beside the control (for example "Not an approver"). */
  tag?: string
  /** Runs after a `select` row's value was saved. */
  onChange?: (value: string) => void
  /** Extra words the settings search matches. */
  keywords?: string
  /** Shows this person's avatar before the title (`row`) or beside the control (`control`). A member id, name or label. */
  avatar?: { who: string; at: 'row' | 'control' }
  /** A `text` row's kind of value: checked when the field loses focus, and not saved while it is wrong. */
  type?: FieldType
  /** A `select` row: the question to ask before saving this value, or null to save it straight away. */
  confirm?: (value: string) => { title: string; text: string; action: string } | null
}

export type FieldType = 'money' | 'email'
/** What's wrong with a typed field's value, or the value to save. */
export function checkField(type: FieldType, raw: string): { error: string } | { value: string } {
  const v = raw.trim()
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { value: v } : { error: 'Enter an email address, like name@company.com.' }
  // Plain digits only, with optional thousands commas and cents: no exponents ("1e3"), hex ("0x10") or signs.
  if (!/^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(v)) return { error: 'Enter an amount above $0, like $300.' }
  const n = Number(v.replace(/^\$/, '').replaceAll(',', ''))
  if (!(n > 0)) return { error: 'Enter an amount above $0, like $300.' }
  if (n > MONEY_MAX) return { error: `Enter an amount up to $${MONEY_MAX.toLocaleString('en-US')}.` }
  // Whole dollars stay whole ("$320"); cents always show two digits ("$300.50").
  return { value: Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}` }
}
/** The largest amount a money field takes: far above any monthly cap a brand this size would set. */
const MONEY_MAX = 100_000
/** `caption` is one visible label over a column of controls (the effort pickers); `empty` is the muted line a section with no rows shows. */
export interface Section { label: string; rows: Row[]; caption?: string; empty?: string }
export interface Page { title: string; sections: Section[] }

/** The time zones, saved as their ids and shown by name. */
const TIME_ZONES: Record<string, string> = {
  'Europe/London': 'UK Time (London)', 'Europe/Dublin': 'Irish Time (Dublin)', 'Europe/Paris': 'Central European Time (Paris)',
  'Europe/Berlin': 'Central European Time (Berlin)', 'America/New_York': 'Eastern Time (New York)', 'America/Chicago': 'Central Time (Chicago)',
  'America/Denver': 'Mountain Time (Denver)', 'America/Los_Angeles': 'Pacific Time (Los Angeles)', 'Australia/Sydney': 'Australian Eastern Time (Sydney)',
}
const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }
const themeFromLabel = (label: string) => (Object.keys(THEME_LABELS) as Theme[]).find(t => THEME_LABELS[t] === label) ?? 'system'
const RETENTION = ['3 months', '6 months', '12 months', '24 months', 'Until deleted']

export const MENU: { label: string; items: [string, string, string][] }[] = [
  { label: 'Your settings', items: [['you-general', 'person', 'General'], ['you-notif', 'notifications', 'Notifications'], ['you-memory', 'neurology', 'Memory']] },
  { label: 'Team settings · admins', items: [['team-plan', 'stairs', 'Stage and plan'], ['team-agent', 'badge', 'Inhouse agent'], ['team-modes', 'psychology', 'Models'], ['team-memory', 'neurology', 'Team memory'], ['team-members', 'group', 'Members'], ['team-approvals', 'task_alt', 'Who approves what'], ['team-limits', 'tune', 'Run limits'], ['team-spend', 'savings', 'Spending cap'], ['team-data', 'shield_lock', 'Data and access'], ['team-audit', 'history_edu', 'Audit log']] },
]

export interface Env {
  S: StageIndex
  stage: string
  agent: AgentState
  data: AgentData
  /** Spent so far this month, from the agent's data (a cap never rescales it). */
  spent: number
  /** On a phone the page is read-only, so a hint about changing a setting is left out. */
  phone: boolean
  openTeam: (type: RequestType, text?: string) => void
  openPop: (pop: Pop) => void
  openSettings: (tab: string) => void
  newChat: (prefill?: string) => void
  goSkills: () => void
  togglePause: () => void
  /** The theme saved on this device, and how to change it (src/lib/theme.ts). */
  theme: Theme
  setTheme: (t: Theme) => void
  toast: (text: string, ms: number, icon?: string) => void
  forget: (key: string) => void
  /** Hands the browser a file to save. */
  download: (file: string, text: string, type: string) => void
}

const withAvatar = (row: Row, who: string, at: 'row' | 'control' = 'row'): Row => ({ ...row, avatar: { who, at } })

const R = (title: string, desc: string, kind: RowKind, value = '', need = 0, key?: string, def?: boolean, onClick?: () => void): Row =>
  ({ title, desc, kind, value, need, key, def, onClick })

/** A dropdown row. `key` is where its value is saved. */
const SEL = (title: string, desc: string, key: string, value: string, options: string[], need = 0): Row =>
  ({ title, desc, kind: 'select', value, need, key, options })
/** A text field row, saved under `key`. */
const TXT = (title: string, desc: string, key: string, value: string, need = 0): Row =>
  ({ title, desc, kind: 'text', value, need, key })

export function settingsPage(tab: string, env: Env): Page {
  const { S, stage, agent, data } = env
  const { auditLog, memory, meta, people, skills, usage } = data
  const me = meta.currentUser
  const forgetRows = (lines: MemoryLine[]) =>
    lines.filter(l => !agent.forgot[l.key]).map(l => R(l.text, l.source, 'button', 'Forget', 1, undefined, undefined, () => env.forget(l.key)))
  const teamMem = memory.team.map(g => ({ label: g.group, rows: forgetRows(g.lines) }))
  const memCount = teamMem.reduce((n, g) => n + g.rows.length, 0)
  const teach = R('Teach it something', 'Tell it a rule in a chat, in your own words. It appears here.', 'button', 'Teach in a chat', 1, undefined, undefined, () => env.newChat('Remember that '))
  const lim = people.runLimits
  const limKeys = ['l:returns', 'l:chase', 'l:nudge', 'l:pause']
  const limDesc = ['When ShipBob marks a return as sellable.', 'One polite chase per purchase order.', 'After 3 days without a pick.', 'Pauses the variant. Customer emails still wait.']
  const auditRow = (e: { who: string; what: string; detail: string; at: string }) => withAvatar(R(`${e.who} ${e.what}`, `${e.detail} · ${e.at}`, 'value'), e.who)
  const pausedRow = agent.paused ? [withAvatar(R(`${me.name} paused your Inhouse agent`, `Routines and jobs stopped · ${agent.paused}`, 'value'), me.id)] : []
  const nextStage = S < 2
    ? ['Act adds drafted work, memory, routines and Slack.', 'Run adds agreed jobs it finishes by itself, within your limits.'][S]
    : 'You have every stage. Money and customer actions still wait for a person.'
  const stageDesc = ['Watch: your Inhouse agent reads every tool and changes nothing.', 'Act: your Inhouse agent does real work, and each piece waits for approval.', 'Run: your Inhouse agent handles agreed jobs by itself, within your limits.'][S]

  // Dropdowns and text fields show what was saved, else the default given here.
  const saved = agent.settings
  const sel = (title: string, desc: string, key: string, def: string, options: string[], need = 0) => SEL(title, desc, key, saved[key] ?? def, options, need)
  const txt = (title: string, desc: string, key: string, def: string, need = 0) => TXT(title, desc, key, saved[key] ?? def, need)
  const modes = thinkingModes(data, saved)
  const modeLabels = modes.filter(m => m.on).map(m => m.label)
  const defaultMode = modes.find(m => m.id === defaultModeId(data, saved))?.label ?? modeLabels[0]
  const modeRows = modes.map((m): Row => ({
    title: m.label, desc: `${m.model} · ${m.sub}${m.label === defaultMode ? (env.phone ? ". It stays on while it's the default." : ". It stays on while it's the default. Pick another default to turn it off.") : ''}`, kind: 'mode', need: 0, key: modeEffortKey(m.id), value: EFFORTS.find(([e]) => e === m.effort)![1], options: EFFORTS.map(([, label]) => label),
    switchKey: modeOnKey(m.id), switchOn: m.on, switchTip: m.label === defaultMode ? 'This is the default model' : undefined, keywords: 'effort how hard it thinks',
  }))
  const approvers = [...people.members.filter(m => (saved[`p:${m.id}`] ?? m.role) !== 'Member').map(m => m.name), 'Anyone who approves']
  const ruleApprover = (r: { approver: string }, i: number) => saved[`a:${i}`] ?? r.approver
  // Demoting an approver leaves the rules that name them as they are, so say so.
  const demoted = (m: { id: string; name: string; role: string }, role: string) => {
    if (role !== 'Member' || (saved[`p:${m.id}`] ?? m.role) === 'Member') return
    const n = people.approvalRules.filter((r, i) => ruleApprover(r, i) === m.name).length
    if (n > 0) env.toast(`${m.name.split(' ')[0]} is still named on ${n} approval ${n === 1 ? 'rule' : 'rules'}.`, 7000)
  }

  // Taking Admin away asks first, and says so plainly when it's your own.
  const removesAdmin = (m: { id: string; name: string; role: string }, role: string) => {
    if (role === 'Admin' || (saved[`p:${m.id}`] ?? m.role) !== 'Admin') return null
    const first = m.name.split(' ')[0]
    return m.id === me.id
      ? { title: 'Remove your admin role?', text: "You won't be able to change team settings any more. Another admin has to give it back.", action: 'Remove admin' }
      : { title: `Remove ${first}'s admin role?`, text: `${first} won't be able to change team settings any more.`, action: 'Remove admin' }
  }

  const pages: Record<string, Page> = {
    'you-general': { title: 'General', sections: [
      { label: 'Profile', rows: [withAvatar({ title: 'Photo', desc: '', kind: 'photo', value: '', need: 0 }, me.id), txt('Name', 'Shown to your team and in approvals.', 'g:name', me.name), R('Email', 'Used to sign in.', 'value', me.email), R('Role', 'Admins can change team settings.', 'value', `${me.title} · ${me.role}`)] },
      { label: 'Appearance', rows: [{ ...SEL('Theme', 'Light or dark. System follows your device.', 'g:theme', THEME_LABELS[env.theme], Object.values(THEME_LABELS)), onChange: v => env.setTheme(themeFromLabel(v)) }, sel('Language', 'Inhouse shows menus and messages in this language.', 'g:lang', 'English (US)', ['English (US)', 'English (UK)', 'Español', 'Français', 'Deutsch']), sel('Text size', 'The size of text and controls.', 'g:size', '100%', ['90%', '100%', '110%', '125%'])] },
      { label: 'Region', rows: [{ ...sel('Time zone', "Your team's time zone.", 'g:tz', 'America/New_York', Object.keys(TIME_ZONES)), labels: TIME_ZONES }] },
    ] },
    'you-notif': { title: 'Notifications', sections: [
      { label: 'Alerts', rows: [sel('Approvals waiting', 'When your Inhouse agent drafts something for you.', 'n:wait', 'Right away', ['Right away', 'Once an hour', 'Once a day'], 1), sel('Send alerts to', 'Where your Inhouse agent tells you about approvals and problems.', 'n:channel', 'Slack', ['Email', 'Slack', 'Email and Slack', 'In the app only'], 1), R('Slack', 'Ask your Inhouse agent and approve work in Slack.', 'toggle', '', 1, 'n:slack', true), R('Weekly report', 'Fridays at 4:00\u00a0PM.', 'toggle', '', 1, 'n:weekly', true)] },
    ] },
    'you-memory': { title: 'Memory', sections: [
      { label: 'What your Inhouse agent knows about you', rows: forgetRows(memory.personal) },
      { label: 'Privacy', rows: [R('Only you can see this', 'Teammates and admins cannot read your personal memory.', 'value', 'Private'), R('Learn from my chats', 'Your Inhouse agent saves your preferences as you work. Turn off to stop.', 'toggle', '', 1, 'm:learn', true)] },
    ] },
    'team-plan': { title: 'Stage and plan', sections: [
      { label: 'Your stage', rows: [R('Current stage', stageDesc, 'value', stage), R('Next stage', nextStage, 'value', S < 2 ? STAGE_TAGS[S + 1] : 'None'), R('Talk to your Inhouse team', 'Move up when you are ready. Every stage includes all your tools.', 'button', 'Book a check-in', 0, undefined, undefined, () => env.openTeam('change', ''))] },
      { label: 'Running costs', rows: [R('AI and hosting', 'Paid at cost, to accounts you own, with a spending cap.', 'value', 'Anthropic · Cloudflare')] },
    ] },
    'team-agent': { title: 'Inhouse agent', sections: [
      { label: 'About', rows: [sel('Tone', 'How it writes to suppliers, customers and your team.', 't:tone', meta.agent.tone, ['Friendly and short', 'Warm and detailed', 'Formal and brief', 'Plain and direct']), txt('Signs emails as', 'Used on supplier and customer emails.', 't:signs', meta.agent.signsEmailsAs)] },
      { label: 'What your Inhouse agent knows', rows: [R('Team memory', `Supplier, customer and stock rules the whole team shares. ${memCount} things remembered.`, 'button', 'Open memory', 1, undefined, undefined, () => env.openSettings('team-memory')), R('Skills', `The jobs it knows how to do. ${skills.length} skills, added by your Inhouse team.`, 'button', 'View skills', 0, undefined, undefined, env.goSkills)] },
    ] },
    'team-modes': { title: 'Models', sections: [
      { label: '', caption: 'How hard it thinks', rows: modeRows },
      { label: '', rows: [sel('Default model', '', 'g:mode', defaultMode, modeLabels)] },
    ] },
    'team-memory': { title: 'Team memory', sections: [
      ...teamMem,
      { label: 'How your Inhouse agent learns', rows: [R('Ask before saving a team rule', 'Your Inhouse agent shows the rule in the chat and an approver confirms it.', 'toggle', '', 1, 'm:ask', true), teach] },
    ] },
    'team-members': { title: 'Members', sections: [
      { label: `${people.members.length} people`, rows: [...people.members.map(m => withAvatar({ ...sel(m.name, `${m.email} · ${m.title}`, `p:${m.id}`, m.role, ['Admin', 'Approver', 'Member']), onChange: v => demoted(m, v), confirm: v => removesAdmin(m, v) }, m.id)), R('Invite someone', 'They log in with their work email.', 'button', 'Invite', 0, undefined, undefined, () => env.openTeam('change', 'Please invite this person to Inhouse. Name, work email and role: '))] },
    ] },
    'team-approvals': { title: 'Who approves what', sections: [
      { label: 'Rules', rows: people.approvalRules.map((r, i) => withAvatar({ ...sel(r.what, r.detail, `a:${i}`, r.approver, approvers, 1), tag: approvers.includes(ruleApprover(r, i)) ? undefined : 'Not an approver' }, ruleApprover(r, i), 'control')) },
    ] },
    'team-limits': { title: 'Run limits', sections: [
      { label: 'Jobs your Inhouse agent may finish by itself', rows: lim.jobsAgentMayFinish.map((name, i) => R(name, limDesc[i], 'toggle', '', 2, limKeys[i], true)) },
      { label: 'How far your Inhouse agent can go', rows: [sel('Daily limit', 'After this many actions in one day, it stops and asks.', 'l:daily', `${lim.dailyActionLimit} actions`, ['10 actions', '25 actions', '50 actions', '100 actions', '200 actions'], 2), sel('Largest restock', 'Bigger restocks wait for a person.', 'l:restock', `${lim.largestRestockUnits} units`, ['25 units', '50 units', '100 units', '250 units', '500 units'], 2)] },
      { label: 'Always waits for a person', rows: [R('Money', 'Orders, refunds, claims and budget changes.', 'value', 'Always'), R('Customers', 'Any message to a customer.', 'value', 'Always'), R('Pause Inhouse agent', 'Stops every routine and job at once. Asking questions still works.', 'button', agent.paused ? 'Resume Inhouse agent' : 'Pause Inhouse agent', 1, undefined, undefined, env.togglePause)] },
    ] },
    'team-spend': { title: 'Spending cap', sections: [
      { label: 'This month', rows: [{ ...txt('Monthly cap', 'Jobs pause when the cap is reached.', 's:cap', `$${usage.cap}`), type: 'money' }, sel('Alert at', 'Admins get an email.', 's:alert', `${usage.alertAt}%`, ['50%', '70%', '80%', '90%', '100%']), sel('Show amounts in', 'The currency used for amounts in reports and emails.', 's:currency', 'USD ($)', ['USD ($)', 'GBP (£)', 'EUR (€)', 'CAD ($)', 'AUD ($)']), R('Spent so far', `${usage.month} ${DEMO_START.getFullYear()}.`, 'value', `$${env.spent.toFixed(2)}`)] },
      { label: 'Accounts', rows: [R('AI', 'Your Anthropic account, billed at cost.', 'value', 'Anthropic'), R('Hosting', 'Your Cloudflare account, billed at cost.', 'value', 'Cloudflare')] },
    ] },
    'team-data': { title: 'Data and access', sections: [
      { label: 'Where your data stays', rows: [R('Your tools', 'Orders, customers and money stay in Shopify, Xero and your other tools. Your Inhouse agent reads what a job needs.', 'value', 'Stays in each tool'), R('Inhouse agent', 'Chats, memory, routines and logs are stored on your own Cloudflare account.', 'value', 'Your Cloudflare'), R('AI models', 'Questions go to Anthropic through your own account.', 'value', 'Your Anthropic')] },
      { label: 'How long things are kept', rows: [sel('Chats', 'Older chats are deleted automatically.', 'd:chats', '12 months', RETENTION), sel('Activity and steps', 'Every step it took, kept for checking later.', 'd:steps', '12 months', RETENTION), R('Audit log', 'Changes to settings, rules and people. Cannot be shortened.', 'value', '12 months')] },
      { label: 'Who can get in', rows: [R('Your team', 'People sign in with their work email.', 'value', `${people.members.length} members`), R('Inhouse team access', 'Alex and the team can sign in to fix and improve your Inhouse agent. Every visit is in the audit log.', 'toggle', '', 0, 'd:support', true), R('Two-step sign-in', 'Everyone confirms with a code when they sign in.', 'toggle', '', 0, 'd:2fa', true)] },
      { label: 'Take it with you', rows: [R('Export everything', 'Chats, memory, routines, skills and logs as one download.', 'button', 'Export', 0, undefined, undefined, () => env.toast("Export isn't connected in this demo.", 4000, 'info')), R('Delete Inhouse agent and its data', 'Removes chats, memory and logs from your Cloudflare account. Your tools are not touched.', 'button', 'Ask the team', 0, undefined, undefined, () => env.openTeam('change', `Please delete the Inhouse agent and its data for ${meta.brand.name}.`))] },
    ] },
    'team-audit': { title: 'Audit log', sections: [
      { label: 'Today', rows: [...pausedRow, ...auditLog.filter(e => e.day === 'Today').map(auditRow)] },
      { label: 'Earlier', rows: auditLog.filter(e => e.day === 'Earlier').map(auditRow) },
      // Day one and while loading: nothing was changed yet.
      { label: '', rows: [], empty: auditLog.length === 0 && pausedRow.length === 0 ? (env.data.status === 'loading' ? 'Still loading. Changes show here in a moment.' : 'Nothing changed yet. Changes to settings, rules and people show here.') : undefined },
      { label: 'Keep a copy', rows: [R('Download the log', 'Every change to settings, rules, people, tools and memory. Kept for 12 months. Nobody can edit it.', 'button', 'Download CSV', 0, undefined, undefined, () => {
        const q = (v: string) => `"${v.replaceAll('"', '""')}"`
        // A plain space in every cell: the no-break space before AM or PM is for the screen, not a spreadsheet.
        const lines = [['When', 'Who', 'What', 'Detail'], ...auditLog.map(e => [`${e.day} ${e.at}`, e.who, e.what, e.detail].map(plainSpaces))]
        env.download('inhouse-audit-log.csv', lines.map(l => l.map(q).join(',')).join('\n') + '\n', 'text/csv')
        env.toast('Audit log downloaded', 4000)
      })] },
    ] },
  }
  return Object.hasOwn(pages, tab) ? pages[tab] : pages['you-general']
}
