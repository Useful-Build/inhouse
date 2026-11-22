// Settings content. Pure data: the screen renders it.
import type { AgentData, AgentState, AuditLine, CanKey, Me, MemberRecord, MemberRole, MemoryLine, Money, StageIndex } from '../../agent/types'
import { STAGE_TAGS, channelFrom, listNames } from '../../state/derive'
import { EFFORTS, defaultModeId, modeEffortKey, modeOnKey, thinkingModes } from '../../state/derive'
import type { Pop, RequestType } from '../../state/store'
import type { Theme } from '../../lib/theme'
import { plainSpaces } from '../../agent/clock'
import { calendarOf, fmtAuditDay, fmtCapSetting, fmtDayWord, fmtMoney, fmtNearDay, fmtSpentSetting, fmtTime, fmtWhen, moneyOf } from '../../lib/format'
import { display, nowOf } from '../../state/display'
import { AUDIT_CSV_HEADER, csvCell } from '../../../shared/csv'
import { grantStatus } from './grant-status'
import { HOSTLIST_MAX_HOSTS, MAX_TURNS, parseHostlist } from '../../../shared/contract/settings-table'

export type RowKind = 'select' | 'text' | 'value' | 'button' | 'toggle' | 'mode' | 'photo' | 'grant'
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
  tagVariant?: 'warning' | 'muted'
  /** What the setting is when nothing was saved, as the row shows it ("the default" in a stale-save notice). */
  defaultValue?: string
  /** A button whose request is in flight: it waits. */
  busy?: boolean
  /** Runs after a `select` row's value was saved. */
  onChange?: (value: string) => void
  /** Extra words the settings search matches. */
  keywords?: string
  /** Shows this person's avatar before the title (`row`) or beside the control (`control`). A member id, name or label. */
  avatar?: { who: string; at: 'row' | 'control' }
  /** A `text` row's kind of value: checked when the field loses focus, and not saved while it is wrong. */
  type?: FieldType
  /** A `select` row saved some way other than a setting (a member's role is its own call): runs instead of `setSetting(key, value)`. */
  save?: (value: string) => void
  /** A `toggle` row that isn't a switch setting (the support grant): whether it is on, and what flipping it does. */
  on?: boolean
  toggle?: (on: boolean) => void
  /** A `select` row: the question to ask before saving this value, or null to save it straight away. */
  confirm?: (value: string) => { title: string; text: string; action: string } | null
  /** A `select` row: what the button says when it isn't the value's own name (a member named on an approval rule reads "Approver"). */
  display?: string
  /** The `me().can` key the row's control needs. Without it the control follows the setting's scope (brand or technical). Not allowed: it shows as text. */
  can?: CanKey
  /** A Remove button beside the control: the question that names the person, and what confirming does. */
  remove?: { label: string; title: string; text: string; action: string; go: () => void }
}

export type FieldType = 'money' | 'email' | 'hosts'
/** What's wrong with a typed field's value, or the value to save. */
export function checkField(type: FieldType, raw: string): { error: string } | { value: string } {
  const v = raw.trim()
  if (type === 'hosts') {
    // One host a line (commas and spaces count as line breaks), lowercase, each once. Empty is fine: any public host.
    const hosts = [...new Set(v.toLowerCase().split(/[\s,]+/).filter(Boolean))]
    return parseHostlist(hosts.join('\n')) ? { value: hosts.join('\n') } : { error: `Use website names like example.com, up to ${HOSTLIST_MAX_HOSTS}.` }
  }
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { value: v } : { error: 'Enter an email address, like name@company.com.' }
  // Plain digits only, with optional thousands commas and cents: no exponents ("1e3"), hex ("0x10") or signs.
  if (!/^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(v)) return { error: 'Enter an amount above $0, like $300.' }
  const n = Number(v.replace(/^\$/, '').replaceAll(',', ''))
  if (!(n > 0)) return { error: 'Enter an amount above $0, like $300.' }
  if (n > MONEY_MAX) return { error: `Enter an amount up to ${fmtMoney(moneyOf(MONEY_MAX, FIELD_CURRENCY), display())}.` }
  // Whole dollars stay whole ("$320"); cents always show two digits ("$300.50"); no thousands separator.
  return { value: fmtMoney(moneyOf(n, FIELD_CURRENCY), display(), { grouping: false }) }
}
/** A money field takes US dollars: the currency the brand is billed in. */
const FIELD_CURRENCY = 'USD'
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
/** A role as the page names it (the Inhouse team is its own principal, not a member role). */
const ROLE_NAMES = { admin: 'Admin', member: 'Member', inhouse: 'Inhouse team' } as const
const RETENTION = ['3 months', '6 months', '12 months', '24 months', 'Until deleted']

export { MENU } from './menu'

export interface Env {
  S: StageIndex
  stage: string
  agent: AgentState
  data: AgentData
  /** Spent so far this month, from the agent's data (a cap never rescales it). */
  spent: Money
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
  /** Changes a member's role (`setMemberRole`). */
  setRole: (id: string, role: MemberRole) => void
  /** Turns Inhouse team access on (a 24 hour grant) or off (ends the live grant `id`). The demo's switch. */
  setSupport: (on: boolean, grantId?: string) => void
  /** Who is signed in (null while loading). */
  me: Me | null
  /** Opens the Invite window. */
  invite: () => void
  /** Removes a member (after the question). */
  removeMember: (id: string) => void
  /** Whether Data and access shows the grant (status, hours, End now) instead of the demo's one switch. */
  grantUi: boolean
  /** Whether the viewer sees the support grant at all: an Admin or the Inhouse team (route 16), or anyone in the demo. */
  showGrant: boolean
  /** The audit log's next page is being read. */
  loadingMore: boolean
  /** The next page of the audit log. */
  loadMore: (list: 'audit' | 'members') => void
  /** Downloads the audit log from where the client says (`auditExportUrl()`), or null when the file is built here. */
  exportFromServer: (() => void) | null
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

/** Where a remembered line came from: "Sam told your Inhouse agent in a chat, Nov 4 · used 7 times", "Learned from 6 past orders · used 12 times, last today". */
export const memorySource = (l: MemoryLine, now: number): string => {
  const d0 = display()
  return l.source + (l.at ? `, ${fmtNearDay(l.at, now, d0)}` : '') + (l.used ? ` · ${l.used}` : '') + (l.lastUsed ? `, last ${fmtDayWord(l.lastUsed, now, d0)}` : '')
}

export function settingsPage(tab: string, env: Env): Page {
  const { S, stage, agent, data } = env
  const { auditLog, memory, meta, people, skills, usage } = data
  const me = meta.currentUser
  const d0 = display()
  const now = nowOf()
  const forgetRows = (lines: MemoryLine[]) =>
    lines.filter(l => !agent.forgot[l.key]).map(l => R(l.text, memorySource(l, now), 'button', 'Forget', 1, undefined, undefined, () => env.forget(l.key)))
  const teamMem = memory.team.map(g => ({ label: g.group, rows: forgetRows(g.lines) }))
  const memCount = teamMem.reduce((n, g) => n + g.rows.length, 0)
  const teach = R('Teach it something', 'Tell it a rule in a chat, in your own words. It appears here.', 'button', 'Teach in a chat', 1, undefined, undefined, () => env.newChat('Remember that '))
  const lim = people.runLimits
  // These rows start at Act, so they name the channel Act connects. None: no channel wording or option.
  const channel = channelFrom(data, 1)?.name
  const alertOptions = channel ? ['Email', channel, `Email and ${channel}`, 'In the app only'] : ['Email', 'In the app only']
  // A saved choice that isn't an option now (another channel, or none) shows and counts as the default.
  const savedTo = agent.settings['n:channel']
  const alertsTo = savedTo && alertOptions.includes(savedTo) ? savedTo : (channel ?? 'Email')
  const auditRow = (e: AuditLine) => withAvatar(R(`${e.who} ${e.what}`, `${e.detail} · ${fmtWhen(e.at, now, d0)}`, 'value'), e.who)
  /** The audit log's two groups: changes made today, and earlier ones. */
  const auditDay = (e: AuditLine) => fmtAuditDay(e.at, now, d0)
  const pausedRow = agent.paused ? [withAvatar(R(`${me.name} paused your Inhouse agent`, `Chats, routines and jobs stopped · ${fmtTime(agent.paused, d0)}`, 'value'), me.id)] : []
  const nextStage = S < 2
    ? [`Act adds ${listNames(['drafted work', 'memory', 'routines', ...(channel ? [channel] : [])])}.`, 'Run adds agreed jobs it finishes by itself, within your limits.'][S]
    : 'You have every stage. Money and customer actions still wait for a person.'
  const stageDesc = ['Watch: your Inhouse agent reads every tool and changes nothing.', 'Act: your Inhouse agent does real work, and each piece waits for approval.', 'Run: your Inhouse agent handles agreed jobs by itself, within your limits.'][S]

  // Dropdowns and text fields show what was saved, else the default given here.
  const saved = agent.settings
  const sel = (title: string, desc: string, key: string, def: string, options: string[], need = 0) => ({ ...SEL(title, desc, key, saved[key] ?? def, options, need), defaultValue: def })
  const txt = (title: string, desc: string, key: string, def: string, need = 0) => ({ ...TXT(title, desc, key, saved[key] ?? def, need), defaultValue: def })
  const modes = thinkingModes(data, saved)
  const modeLabels = modes.filter(m => m.on).map(m => m.label)
  const defaultMode = modes.find(m => m.id === defaultModeId(data, saved))?.label ?? modeLabels[0]
  const modeRows = modes.map((m): Row => ({
    title: m.label, desc: `${m.model} · ${m.sub}${m.label === defaultMode ? ' · stays on as the default' : ''}`, kind: 'mode', need: 0, key: modeEffortKey(m.id), value: EFFORTS.find(([e]) => e === m.effort)![1], options: EFFORTS.map(([, label]) => label),
    switchKey: modeOnKey(m.id), switchOn: m.on, switchTip: m.label === defaultMode ? 'This is the default model. Pick another default to turn it off.' : undefined, keywords: 'effort how hard it thinks',
  }))
  // Approving is a job per rule, by member id (not a role): a member named on a rule shows as "Approver".
  const team = people.members.filter(m => m.status !== 'removed')
  const namedOnRules = (id: string) => people.approvalRules.filter(r => r.approver === id).length
  const roleLabel = (m: MemberRecord) => (m.role === 'admin' ? 'Admin' : namedOnRules(m.id) > 0 ? 'Approver' : 'Member')
  const approverIds = [...team.map(m => m.id), 'anyone']
  const approverLabels: Record<string, string> = { anyone: 'Anyone who approves', ...Object.fromEntries(people.members.map(m => [m.id, m.name])) }
  // Moving a named approver to Member leaves the rules that name them as they are, so say so.
  const demoted = (m: MemberRecord, label: string) => {
    if (label !== 'Member' || roleLabel(m) === 'Member') return
    const n = namedOnRules(m.id)
    if (n > 0) env.toast(`${m.name.split(' ')[0]} is still named on ${n} approval ${n === 1 ? 'rule' : 'rules'}.`, 7000)
  }

  // Taking Admin away asks first, and says so plainly when it's your own.
  const removesAdmin = (m: MemberRecord, label: string) => {
    if (label === 'Admin' || m.role !== 'admin') return null
    const first = m.name.split(' ')[0]
    return m.id === me.id
      ? { title: 'Remove your admin role?', text: "You won't be able to change team settings any more. Another admin has to give it back.", action: 'Remove admin' }
      : { title: `Remove ${first}'s admin role?`, text: `${first} won't be able to change team settings any more.`, action: 'Remove admin' }
  }
  const grant = people.supportGrant
  const self = people.members.find(m => m.id === me.id)

  const supportRow: Row = { ...R('Inhouse team access', 'Alex and the team can sign in to fix and improve your Inhouse agent. Every visit is in the audit log.', env.grantUi ? 'grant' : 'toggle', env.grantUi ? grantStatus(grant, now, d0) : '', 0, 'd:support', true), can: 'grantSupport', on: !!grant?.live, toggle: next => env.setSupport(next, grant?.id) }
  const pages: Record<string, Page> = {
    'you-general': { title: 'General', sections: [
      { label: 'Profile', rows: [withAvatar({ title: 'Photo', desc: '', kind: 'photo', value: '', need: 0 }, me.id), txt('Name', 'Shown to your team and in approvals.', 'g:name', me.name), R('Email', 'Used to sign in.', 'value', env.me ? env.me.email ?? '' : me.email), R('Role', 'Admins can change team settings.', 'value', `${self?.title ?? me.title} · ${env.me ? ROLE_NAMES[env.me.role] : me.role}`)] },
      { label: 'Appearance', rows: [{ ...SEL('Theme', 'Light or dark. System follows your device.', 'g:theme', THEME_LABELS[env.theme], Object.values(THEME_LABELS)), onChange: v => env.setTheme(themeFromLabel(v)) }, sel('Language', 'Inhouse shows menus and messages in this language.', 'g:lang', 'English (US)', ['English (US)', 'English (UK)', 'Español', 'Français', 'Deutsch']), sel('Text size', 'The size of text and controls.', 'g:size', '100%', ['90%', '100%', '110%', '125%'])] },
      { label: 'Region', rows: [{ ...sel('Time zone', "Your team's time zone.", 'g:tz', 'America/New_York', Object.keys(TIME_ZONES)), labels: TIME_ZONES }] },
    ] },
    'you-notif': { title: 'Notifications', sections: [
      { label: 'Alerts', rows: [sel('Approvals waiting', 'When your Inhouse agent drafts something for you.', 'n:wait', 'Right away', ['Right away', 'Once an hour', 'Once a day'], 1), SEL('Send alerts to', 'Where your Inhouse agent tells you about approvals and problems.', 'n:channel', alertsTo, alertOptions, 1), ...(channel ? [R(channel, `Ask your Inhouse agent and approve work in ${channel}.`, 'toggle', '', 1, 'n:slack' /* the channel toggle: the key stays so saved demo state still lines up */, true)] : []), R('Weekly report', 'Fridays at 4:00\u00a0PM.', 'toggle', '', 1, 'n:weekly', true)] },
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
      { label: 'Answers', rows: [
        sel('Most steps in one answer', 'An answer that needs more steps than this stops and says so.', 't:max_turns', '25', [...MAX_TURNS]),
        { ...txt('Websites it may open', 'One website name a line. Leave empty and it may open any public website.', 't:webfetch', ''), type: 'hosts', keywords: 'webfetch hosts domains allowlist' },
      ] },
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
      { label: `${team.length} people`, rows: [...team.map(m => {
        const label = roleLabel(m)
        const first = m.name.split(' ')[0]
        const named = namedOnRules(m.id)
        return withAvatar({ ...SEL(m.name, [m.email, m.title].filter(Boolean).join(' · '), `p:${m.id}`, m.role === 'admin' ? 'Admin' : 'Member', ['Admin', 'Member']), display: label === 'Approver' ? label : undefined, tag: m.status === 'invited' ? 'Invited' : undefined, tagVariant: 'muted', can: 'changeRole', save: v => env.setRole(m.id, v === 'Admin' ? 'admin' : 'member'), onChange: v => demoted(m, v), confirm: v => removesAdmin(m, v),
          remove: m.id === me.id || (env.me?.role === 'inhouse' && m.role === 'admin') ? undefined : { label: `Remove ${m.name}`, title: `Remove ${m.name}?`, text: `${first} loses access to Inhouse.${named > 0 ? ` ${first} stays named on ${named} approval ${named === 1 ? 'rule' : 'rules'}, tagged "Not an approver".` : ''} The audit log keeps what ${first} did.`, action: 'Remove', go: () => env.removeMember(m.id) } }, m.id)
      }), { ...R('Invite someone', 'They sign in with their work email.', 'button', 'Invite', 0, undefined, undefined, env.invite), can: 'invite' }] },
    ] },
    'team-approvals': { title: 'Who approves what', sections: [
      { label: 'Rules', rows: people.approvalRules.map((r, i) => withAvatar({ ...SEL(r.what, r.detail, `a:${i}`, r.approver, approverIds, 1), labels: approverLabels, tag: people.members.find(m => m.id === r.approver)?.status === 'removed' ? 'Not an approver' : undefined }, r.approver, 'control')) },
    ] },
    'team-limits': { title: 'Run limits', sections: [
      { label: 'Jobs your Inhouse agent may finish by itself', rows: lim.jobsAgentMayFinish.map(({ id, name, desc }) => R(name, desc, 'toggle', '', 2, `l:${id}`, true)) },
      { label: 'How far your Inhouse agent can go', rows: [sel('Daily limit', 'After this many actions in one day, it stops and asks.', 'l:daily', `${lim.dailyActionLimit} actions`, ['10 actions', '25 actions', '50 actions', '100 actions', '200 actions'], 2), sel('Largest restock', 'Bigger restocks wait for a person.', 'l:restock', `${lim.largestRestockUnits} units`, ['25 units', '50 units', '100 units', '250 units', '500 units'], 2)] },
      { label: 'Always waits for a person', rows: [R('Money', 'Orders, refunds, claims and budget changes.', 'value', 'Always'), R('Customers', 'Any message to a customer.', 'value', 'Always'), R('Pause Inhouse agent', 'Stops every chat, routine and job at once.', 'button', agent.paused ? 'Resume Inhouse agent' : 'Pause Inhouse agent', 1, undefined, undefined, env.togglePause)] },
    ] },
    'team-spend': { title: 'Spending cap', sections: [
      { label: 'This month', rows: [{ ...txt('Monthly cap', 'Chats, routines and jobs pause when the cap is reached.', 's:cap', fmtCapSetting(usage.cap, d0)), type: 'money' }, sel('Alert at', 'Admins get an email.', 's:alert', `${usage.alertAt}%`, ['50%', '70%', '80%', '90%', '100%']), sel('Show amounts in', 'The currency used for amounts in reports and emails.', 's:currency', 'USD ($)', ['USD ($)', 'GBP (£)', 'EUR (€)', 'CAD ($)', 'AUD ($)']), R('Spent so far', `${usage.month} ${usage.monthKey?.slice(0, 4) ?? calendarOf(now, d0).year}.`, 'value', fmtSpentSetting(env.spent, d0))] },
      { label: 'Accounts', rows: [R('AI', 'Your Anthropic account, billed at cost.', 'value', 'Anthropic'), R('Hosting', 'Your Cloudflare account, billed at cost.', 'value', 'Cloudflare')] },
    ] },
    'team-data': { title: 'Data and access', sections: [
      { label: 'Where your data stays', rows: [R('Your tools', 'Orders, customers and money stay in your own tools. Your Inhouse agent reads what a job needs.', 'value', 'Stays in each tool'), R('Inhouse agent', 'Chats, memory, routines and logs are stored on your own Cloudflare account.', 'value', 'Your Cloudflare'), R('AI models', 'Questions go to Anthropic through your own account.', 'value', 'Your Anthropic')] },
      { label: 'How long things are kept', rows: [sel('Chats', 'Older chats are deleted automatically.', 'd:chats', '12 months', RETENTION), sel('Activity and steps', 'Every step it took, kept for checking later.', 'd:steps', '12 months', RETENTION), R('Audit log', 'Changes to settings, rules and people. Cannot be shortened.', 'value', '12 months')] },
      { label: 'Who can get in', rows: [R('Your team', 'People sign in with their work email.', 'value', `${team.length} members`), ...(env.showGrant ? [supportRow] : []), R('Two-step sign-in', 'Everyone confirms with a code when they sign in.', 'toggle', '', 0, 'd:2fa', true)] },
      { label: 'Take it with you', rows: [R('Export everything', 'Chats, memory, routines, skills and logs as one download.', 'button', 'Export', 0, undefined, undefined, () => env.toast("Export isn't connected in this demo.", 4000, 'info')), R('Delete Inhouse agent and its data', 'Removes chats, memory and logs from your Cloudflare account. Your tools are not touched.', 'button', 'Ask the team', 0, undefined, undefined, () => env.openTeam('change', `Please delete the Inhouse agent and its data for ${meta.brand.name}.`))] },
    ] },
    'team-audit': { title: 'Audit log', sections: [
      { label: 'Today', rows: [...pausedRow, ...auditLog.filter(e => auditDay(e) === 'Today').map(auditRow)] },
      { label: 'Earlier', rows: auditLog.filter(e => auditDay(e) === 'Earlier').map(auditRow) },
      // Day one and while loading: nothing was changed yet.
      { label: '', rows: [], empty: auditLog.length === 0 && pausedRow.length === 0 ? (env.data.status === 'loading' ? 'Still loading. Changes show here in a moment.' : 'Nothing changed yet. Changes to settings, rules and people show here.') : undefined },
      { label: '', rows: data.more.audit ? [{ ...R('Older changes', 'Showing the most recent changes.', 'button', 'Load more', 0, undefined, undefined, () => env.loadMore('audit')), busy: env.loadingMore }] : [] },
      { label: 'Keep a copy', rows: [{ ...R('Download the log', 'Every change to settings, rules, people, tools and memory. Kept for 12 months. Nobody can edit it.', 'button', 'Download CSV', 0, undefined, undefined, () => {
        if (env.exportFromServer) return env.exportFromServer()
        // A plain space in every cell: the no-break space before AM or PM is for the screen, not a spreadsheet.
        const lines = [[...AUDIT_CSV_HEADER], ...auditLog.map(e => [`${auditDay(e)} ${fmtWhen(e.at, now, d0)}`, e.who, e.what, e.detail].map(plainSpaces))]
        env.download('inhouse-audit-log.csv', lines.map(l => l.map(csvCell).join(',')).join('\n') + '\n', 'text/csv')
        env.toast('Audit log downloaded', 4000)
      }), can: 'exportAudit' }] },
    ] },
  }
  return Object.hasOwn(pages, tab) ? pages[tab] : pages['you-general']
}
