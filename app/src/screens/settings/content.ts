// Settings content. Pure data: the screen renders it.
import type { AvailableChannel, NotifyChannelList } from '../../agent/types'
import type { NotifyChannel, NotifyPosting } from '../../../shared/contract/notify-slack'
import type { AgentData, AgentState, AuditLine, CanKey, Me, MemberRecord, MemberRole, MemoryLine, Money } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { CONFLICT, FORBIDDEN, REASON } from '../../../shared/contract/error-codes'
import type { WaitingState } from './waiting-list'
import { EFFORTS, defaultModeId, modeEffortKey, modeOnKey, thinkingModes } from '../../state/derive'
import type { Pop, RequestType } from '../../state/store'
import type { Theme } from '../../lib/theme'
import { plainSpaces } from '../../agent/clock'
import { calendarOf, fmtAuditDay, fmtCapSetting, fmtDayWord, fmtMoney, fmtNearDay, fmtSpentSetting, fmtTime, fmtWhen, moneyOf } from '../../lib/format'
import { display, nowOf } from '../../state/display'
import { AUDIT_CSV_HEADER, csvCell } from '../../../shared/csv'
import { grantStatus } from './grant-status'
import { DEFAULT_JOB_BUDGET_USD, HOSTLIST_MAX_HOSTS, MAX_JOB_BUDGET_USD, MAX_TURNS, MIN_JOB_BUDGET_USD, parseHostlist } from '../../../shared/contract/settings-table'
import { dataExportFileName, nextCleanupMs } from '../../../shared/contract/data-access'
import { demoExport } from './demo-export'

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
  /** A small tag shown beside the control (for example "Invited"). */
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
  confirm?: (value: string) => { title: string; text: string; action: string; /** The action gives something rather than taking it away: drawn as a normal action, not in the destructive colour. */ gives?: true } | null
  /** A `select` row: what the button says when it isn't the value's own name ("Choose a channel" before one is picked). */
  display?: string
  /** The `me().can` key the row's control needs. Without it the control follows the setting's scope (brand or technical). Not allowed: it shows as text. */
  can?: CanKey
  /** A Remove button beside the control: the question that names the person, and what confirming does. */
  remove?: { label: string; title: string; text: string; action: string; go: () => void; /** The `me().can` key Remove needs (P5 W4); without it, `remove` (a member's removal). */ can?: CanKey }
  /** A `button` row's accessible name, when its visible label alone doesn't say which row it acts on (a waiting fact's Approve). */
  ariaLabel?: string
  /** A second button beside a `button` row's own (a waiting fact's Reject): its label, its accessible name, the question asked first, and what it does. */
  also?: { label: string; ariaLabel: string; ask?: { title: string; text: string; action: string }; go: () => void }
}

/** `jobBudget` is a money field held between the ledger's start hold and the Inhouse ceiling (`s:job_cap`, M1-F). */
export type FieldType = 'money' | 'jobBudget' | 'email' | 'hosts'
/** What's wrong with a typed field's value, or the value to save. */
export function checkField(type: FieldType, raw: string): { error: string } | { value: string } {
  const v = raw.trim()
  if (type === 'hosts') {
    // One host a line (commas and spaces count as line breaks), lowercase, each once. An empty list blocks all websites.
    const hosts = [...new Set(v.toLowerCase().split(/[\s,]+/).filter(Boolean))]
    return parseHostlist(hosts.join('\n')) ? { value: hosts.join('\n') } : { error: `Use website names like example.com, up to ${HOSTLIST_MAX_HOSTS}.` }
  }
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { value: v } : { error: 'Enter an email address, like name@company.com.' }
  const usd = (n: number) => fmtMoney(moneyOf(n, FIELD_CURRENCY), display())
  const job = type === 'jobBudget'
  const wrong = job ? `Enter an amount from ${usd(MIN_JOB_BUDGET_USD)} to ${usd(MAX_JOB_BUDGET_USD)}.` : 'Enter an amount above $0, like $300.'
  // Plain digits only, with optional thousands commas and cents: no exponents ("1e3"), hex ("0x10") or signs.
  if (!/^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(v)) return { error: wrong }
  const n = Number(v.replace(/^\$/, '').replaceAll(',', ''))
  if (!(n > 0)) return { error: wrong }
  if (job && (n < MIN_JOB_BUDGET_USD || n > MAX_JOB_BUDGET_USD)) return { error: wrong }
  if (n > MONEY_MAX) return { error: `Enter an amount up to ${usd(MONEY_MAX)}.` }
  // Whole dollars stay whole ("$320"); cents always show two digits ("$300.50"); no thousands separator.
  return { value: fmtMoney(moneyOf(n, FIELD_CURRENCY), display(), { grouping: false }) }
}
/** A money field takes US dollars: the currency the brand is billed in. */
const FIELD_CURRENCY = 'USD'
/** The largest amount a money field takes: far above any monthly cap a brand this size would set. */
const MONEY_MAX = 100_000
/** `caption` is one visible label over a column of controls (the effort pickers); `empty` is the muted line a section with no rows shows. */
export interface Section { label: string; rows: Row[]; caption?: string; empty?: string }
/** `keywords`: what the settings search matches on a page drawn by its own component (no rows to match). */
export interface Page { title: string; sections: Section[]; keywords?: string }

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

export { SECTIONS, SETTINGS_PAGES, hasSlack, menuFor } from './menu'
import { hasSlack, pageShown } from './menu'

export interface Env {
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
  /** The product build (no demo): the demo-only rows (settings nothing reads yet) are left out of the pages. */
  product: boolean
  /** Whether the viewer sees the support grant at all: an Admin or the Inhouse team (route 16), or anyone in the demo. */
  showGrant: boolean
  /** The audit log's next page is being read. */
  loadingMore: boolean
  /** The next page of the audit log. */
  loadMore: (list: 'audit' | 'members') => void
  /** Downloads the audit log from where the client says (`auditExportUrl()`), or null when the file is built here. */
  exportFromServer: (() => void) | null
  /** P5 W4: the Slack channels listed for notices (Settings.tsx reads them while the page is open). */
  notify: NotifyView
  /**
   * Starts Export everything's download from the server, or null when the demo builds its sample here: asks route 96
   * first and navigates to route 95 only when it would start. Resolves once the download has started; rejects with the
   * check's `AgentError` (nothing navigated).
   */
  exportDataFromServer: (() => Promise<void>) | null
  /**
   * P6a: the team facts waiting for an OK (waiting-list.ts) and what the page does with them: approve (`true`) or reject one,
   * and read the list again after a failed read. Unset for someone who can't approve.
   */
  waiting?: { state: WaitingState; decide: (key: string, approved: boolean) => void; retry: () => void }
}

/** The Slack notices page's data and its writes. Every write sends the whole list with the rev it was read at. */
export interface NotifyView {
  status: 'idle' | 'loading' | 'ready' | 'error'
  list: NotifyChannelList | null
  /** What the connected Slack account can list (Admins and the Inhouse team); null while unread or unreadable. */
  available: AvailableChannel[] | null
  /** Why the picker isn't offered: Slack isn't connected (or is paused or needs a reconnect), or it couldn't be reached. */
  pickerError: 'disconnected' | 'unavailable' | null
  /** The picker's channels are being read. */
  pickerLoading: boolean
  /** The picker stopped at its page limit (2,000 channels). */
  truncated: boolean
  /** Whether this person may change the list: an Admin or the Inhouse team. */
  canEdit: boolean
  busy: boolean
  add: (channelId: string) => void
  remove: (channelId: string) => void
  setAlerts: (channelId: string | null) => void
  retry: () => void
}

/**
 * Stage 1 M3-C (N27; the M2 carry-over from #449): what marking a channel for alerts gives the agent, said before anyone
 * marks one. An admin's mark is a standing permission to post there without asking, up to the effective daily limit
 * (`posting.perDay`: the smaller of the grant's own and the Inhouse ceiling's); while posting is off there's no limit
 * to show yet; the Inhouse team's mark gives none (only an admin grants for the brand, D4).
 */
export function alertsDisclosure(posting: NotifyPosting, viewer: 'admin' | 'inhouse' | null): string {
  if (viewer === 'inhouse') return "Approvals, questions and problems post here. Marking it gives no permission: only an admin's mark lets the agent post here without asking."
  if (!posting.on) return 'Approvals, questions and problems post here. Once posting is switched on, marking a channel lets the agent post there without asking.'
  return `Marking this channel lets the agent post here without asking, up to ${posting.perDay} posts a day. Approvals, questions and problems post here too.`
}

/** The alerts channel's own line: whether the agent holds a standing permission to post there now (N27). */
function alertsChannelDesc(c: NotifyChannel, posting: NotifyPosting): string {
  if (c.permission) return `The alerts channel. Standing permission: the agent posts here without asking, up to ${c.permission.perDay} posts a day. Approvals, questions and problems post here too.`
  if (!posting.on) return 'The alerts channel. Approvals, questions and problems post here. No standing permission: once posting is switched on, marking it lets the agent post here without asking.'
  return 'The alerts channel. Approvals, questions and problems post here. No standing permission: the agent asks before it posts here.'
}

/**
 * The Slack notices page (P5 W4, p5-w4.md section 10). No stage words (M2-I; the demo too since A13). `product`: the
 * product build, whose posting state the demo doesn't serve yet.
 * Stage 1 M3-C (N27): in the product it says what the alerts mark gives (`viewer`: who is looking, for whose mark gives a
 * permission) and links an admin to Always allowed, where the permission can be removed.
 */
function slackPage(nv: NotifyView, product: boolean, viewer: MemberRole | 'inhouse' | null, openSettings: (tab: string) => void): Page {
  const listed = nv.list?.channels ?? []
  const posting = nv.list?.posting ?? null
  const rules: Section = { label: 'How notices work', rows: [
    // Stage 1 M2-N: in the product the agent's posts to a listed channel are off until the Inhouse team switches posting
    // on (N2), so its notices reach the bell; the server's own fixed alerts (a failed routine) post to the alerts channel.
    posting?.on
      ? R('Agent posts', "Your Inhouse agent asks before it posts to a listed channel, unless it has a standing permission there. Inhouse's own alerts, like a failed routine, post to your alerts channel.", 'value')
      : R('For now', "The agent's notices reach the bell in the app. Inhouse's own alerts, like a failed routine, post to your alerts channel.", 'value'),
    R('While Slack is paused', 'Alerts pause while Slack is paused or needs a reconnect.', 'value'),
    R('Who can read them', 'Anyone in a listed channel can read these alerts, guests included.', 'value'),
  ] }
  if (nv.status !== 'ready') {
    return { title: 'Slack notices', sections: [
      { label: 'Channels', rows: nv.status === 'error' ? [R("Couldn't load the channels", 'Check your connection and try again.', 'button', 'Try again', 0, undefined, undefined, nv.retry)] : [], empty: nv.status === 'error' ? undefined : 'Loading the channels.' },
      rules,
    ] }
  }
  const channelRows = listed.map((c): Row => ({
    ...R(`#${c.name}`, !c.alerts ? 'Your Inhouse agent can post notices here.' : product && posting ? alertsChannelDesc(c, posting) : 'The alerts channel. Approvals, questions and problems post here too.', 'value'),
    ...(nv.canEdit ? { remove: { label: `Remove #${c.name}`, title: `Remove #${c.name}?`, text: 'Your Inhouse agent stops posting there. Notices already posted stay in Slack.', action: 'Remove', go: () => nv.remove(c.channelId), can: 'editBrandSettings' as const } } : {}),
  }))
  // Stage 1 M3-C (N27): where the alerts channel's standing permission is removed. Only an admin sees the brand's
  // permissions there (route 110), so only an admin gets the button.
  const held = product ? listed.find(c => c.alerts && c.permission) : undefined
  if (held) {
    channelRows.push(viewer === 'admin'
      ? { ...R('Standing permission', `To stop the agent posting to #${held.name} without asking, remove it in Always allowed.`, 'button', 'Open Always allowed', 0, undefined, undefined, () => openSettings('you-permissions')), ariaLabel: 'Open Always allowed to remove the standing permission' }
      : R('Standing permission', `An admin can remove the agent's standing permission to post to #${held.name}.`, 'value'))
  }
  const editRows: Row[] = []
  if (nv.canEdit) {
    if (nv.pickerError) {
      editRows.push({ ...R('Add a channel', nv.pickerError === 'disconnected' ? "Slack isn't connected, or it's paused or needs a reconnect on the Tools page." : "Slack couldn't be reached. Try again in a moment.", 'button', 'Try again', 0, undefined, undefined, nv.retry), busy: nv.pickerLoading })
    } else if (nv.pickerLoading && !nv.available) {
      editRows.push({ ...R('Add a channel', 'Reading the channels from Slack.', 'button', 'Loading'), busy: true })
    } else if (nv.available) {
      const open = nv.available.filter(a => !a.disabled && !listed.some(l => l.channelId === a.channelId))
      const blocked = nv.available.some(a => a.disabled)
      editRows.push({
        ...SEL('Add a channel', [blocked ? "Channels shared with another company, and ones the connected Slack account isn't in, can't be added." : 'Public channels in your Slack.', nv.truncated ? 'Showing the first 2,000 channels.' : ''].filter(Boolean).join(' '), 'nc:add', '', open.map(a => `#${a.name}`)),
        display: open.length > 0 ? 'Choose a channel' : 'None to add', busy: nv.busy, can: 'editBrandSettings', keywords: 'slack channel add list',
        save: v => { const a = open.find(x => `#${x.name}` === v); if (a) nv.add(a.channelId) },
      })
    }
    if (listed.length > 0) {
      const current = listed.find(c => c.alerts)
      const who = viewer === 'admin' || viewer === 'inhouse' ? viewer : null
      editRows.push({
        ...SEL('Alerts channel', product && posting ? alertsDisclosure(posting, who) : 'Where approvals, questions and problems are posted.', 'nc:alerts', current ? `#${current.name}` : 'None', ['None', ...listed.map(c => `#${c.name}`)]),
        can: 'editBrandSettings', keywords: 'slack alerts approvals standing permission',
        save: v => nv.setAlerts(v === 'None' ? null : listed.find(c => `#${c.name}` === v)?.channelId ?? null),
        // Stage 1 M3-C (N27): an admin's mark gives a standing permission while posting is on, so it's said and asked first.
        ...(product && posting?.on && who === 'admin' ? {
          confirm: (v: string) => (v === 'None' || v === (current ? `#${current.name}` : 'None') ? null : {
            title: `Mark ${v} for alerts?`, text: alertsDisclosure(posting, 'admin'), action: 'Mark for alerts', gives: true,
          }),
        } : {}),
      })
    }
  }
  return { title: 'Slack notices', sections: [
    { label: 'Channels', rows: channelRows, empty: channelRows.length === 0 ? 'No channels yet. Your Inhouse agent posts only to channels listed here.' : undefined },
    { label: '', rows: editRows },
    rules,
  ] }
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

/** What the person reads when Export everything's check (route 96) refuses: the download never started. */
export function exportRefused(e: unknown): string {
  const code = e instanceof AgentError ? e.code : null
  const reason = e instanceof AgentError ? e.reason : undefined
  if (code === CONFLICT && reason === REASON.tooLarge) return 'Your brand has too much data for one download. Ask the Inhouse team to export it for you.'
  if (code === FORBIDDEN && reason === REASON.grantRequired) return 'Support access has ended, so the export didn\'t start. Ask an admin to grant it again.'
  if (code === FORBIDDEN) return "You can't export this brand's data."
  return "The export didn't start. Try again in a minute."
}

export function settingsPage(tab: string, env: Env): Page {
  const { agent, data } = env
  const { auditLog, memory, meta, people, skills, usage } = data
  const me = meta.currentUser
  const d0 = display()
  const now = nowOf()
  const forgetRows = (lines: MemoryLine[]) =>
    lines.filter(l => !agent.forgot[l.key]).map(l => R(l.text, memorySource(l, now), 'button', 'Forget', 0, undefined, undefined, () => env.forget(l.key)))
  const teamMem = memory.team.map(g => ({ label: g.group, rows: forgetRows(g.lines) }))
  // P6a: what waits for an admin's OK, above the team's rules, for someone who may approve. Nothing waiting: no section.
  const w = env.me?.can.approveMemory ? env.waiting : undefined
  const waitingRows: Row[] = !w ? [] : w.state.status === 'failed'
    ? [{ ...R("Couldn't load what waits for your OK.", '', 'button', 'Retry', 0, undefined, undefined, w.retry), can: 'approveMemory' as const, busy: w.state.reading }]
    : w.state.facts.map(l => ({
      ...R(l.text, memorySource(l, now), 'button', 'Approve', 0, undefined, undefined, () => w.decide(l.key, true)),
      can: 'approveMemory' as const,
      ariaLabel: `Approve: ${l.text}`,
      busy: w.state.deciding.has(l.key),
      also: { label: 'Reject', ariaLabel: `Reject: ${l.text}`, ask: { title: 'Reject this rule?', text: "Your Inhouse agent won't use it.", action: 'Reject' }, go: () => w.decide(l.key, false) },
    }))
  const waitingMem = waitingRows.length > 0 ? [{ label: 'Waiting for your OK', rows: waitingRows }] : []
  const memCount = teamMem.reduce((n, g) => n + g.rows.length, 0)
  const teach = R('Teach it something', "Tell it a rule in a chat, in your own words. It shows here, after an admin's OK if Ask is on.", 'button', 'Teach in a chat', 0, undefined, undefined, () => env.newChat('Remember that '))
  const auditRow = (e: AuditLine) => withAvatar(R(`${e.who} ${e.what}`, `${e.detail} · ${fmtWhen(e.at, now, d0)}`, 'value'), e.who)
  /** The audit log's two groups: changes made today, and earlier ones. */
  const auditDay = (e: AuditLine) => fmtAuditDay(e.at, now, d0)
  const pausedRow = agent.paused ? [withAvatar(R(`${me.name} paused your Inhouse agent`, `Chats, routines and jobs stopped · ${fmtTime(agent.paused, d0)}`, 'value'), me.id)] : []
  // Data and access (P8a D). The retention periods are the Inhouse team's to set; anyone else reads them as text, so say who.
  const setByTeam = env.me && !env.me.can.editTechnical ? ' The Inhouse team sets this.' : ''
  const cleanupAt = nextCleanupMs(now)
  const cleanupDay = fmtDayWord(cleanupAt, now, d0)
  const nextCleanup = `${cleanupDay.charAt(0).toUpperCase()}${cleanupDay.slice(1)} at ${fmtTime(cleanupAt, d0)}`
  const exportEverything = () => {
    if (env.exportDataFromServer) {
      env.exportDataFromServer().then(
        () => { env.toast('Your export is downloading. Big brands can take a few minutes.', 6000) },
        (e: unknown) => { env.toast(exportRefused(e), 8000, 'info') },
      )
      return
    }
    env.download(dataExportFileName(now), demoExport(people.members, agent.settings, now), 'application/x-ndjson')
    env.toast('Sample export downloaded. The demo uses invented data.', 4000, 'info')
  }

  // Dropdowns and text fields show what was saved, else the default given here.
  const saved = agent.settings
  const sel = (title: string, desc: string, key: string, def: string, options: string[], need = 0) => ({ ...SEL(title, desc, key, saved[key] ?? def, options, need), defaultValue: def })
  const txt = (title: string, desc: string, key: string, def: string, need = 0) => ({ ...TXT(title, desc, key, saved[key] ?? def, need), defaultValue: def })
  // The brand's name as saved (the product fills `meta.brand.name` from the same setting; the demo has its sample name).
  const brandName = (saved['b:name'] ?? meta.brand.name).trim()
  const modes = thinkingModes(data, saved)
  const modeLabels = modes.filter(m => m.on).map(m => m.label)
  const defaultMode = modes.find(m => m.id === defaultModeId(data, saved))?.label ?? modeLabels[0]
  const modeRows = modes.map((m): Row => ({
    title: m.label, desc: `${m.model} · ${m.sub}${m.label === defaultMode ? ' · stays on as the default' : ''}`, kind: 'mode', need: 0, key: modeEffortKey(m.id), value: EFFORTS.find(([e]) => e === m.effort)![1], options: EFFORTS.map(([, label]) => label),
    switchKey: modeOnKey(m.id), switchOn: m.on, switchTip: m.label === defaultMode ? 'This is the default model. Pick another default to turn it off.' : undefined, keywords: 'effort how hard it thinks',
  }))
  // A member is an Admin or a Member. Approving is a job per rule, by member id, so the Members page says nothing about rules.
  const team = people.members.filter(m => m.status !== 'removed')
  // What only the demo offers: rows for settings nothing reads yet.
  const demoOnly = (...rows: Row[]): Row[] => (env.product ? [] : rows)

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

  const supportRow: Row = { ...R('Inhouse team access', 'Your Inhouse team can sign in to fix and improve your Inhouse agent. Every visit is in the audit log.', env.grantUi ? 'grant' : 'toggle', env.grantUi ? grantStatus(grant, now, d0) : '', 0, 'd:support', true), can: 'grantSupport', on: !!grant?.live, toggle: next => env.setSupport(next, grant?.id) }
  const pages: Record<string, Page> = {
    'you-general': { title: 'General', sections: [
      { label: 'Profile', rows: [withAvatar({ title: 'Photo', desc: '', kind: 'photo', value: '', need: 0 }, me.id), txt('Name', 'Shown to your team and in approvals.', 'g:name', me.name), R('Email', 'Used to sign in.', 'value', env.me ? env.me.email ?? '' : me.email), R('Role', 'Admins can change team settings.', 'value', [self?.title ?? me.title, env.me ? ROLE_NAMES[env.me.role] : me.role].filter(Boolean).join(' · '))] },
      { label: 'Appearance', rows: [{ ...SEL('Theme', 'Light or dark. System follows your device.', 'g:theme', THEME_LABELS[env.theme], Object.values(THEME_LABELS)), onChange: v => env.setTheme(themeFromLabel(v)) }, ...demoOnly(sel('Language', 'Inhouse shows menus and messages in this language.', 'g:lang', 'English (US)', ['English (US)', 'English (UK)', 'Español', 'Français', 'Deutsch']), sel('Text size', 'The size of text and controls.', 'g:size', '100%', ['90%', '100%', '110%', '125%']))] },
      { label: 'Region', rows: [{ ...sel('Time zone', "Your team's time zone.", 'g:tz', 'America/New_York', Object.keys(TIME_ZONES)), labels: TIME_ZONES }] },
    ] },
    'you-memory': { title: 'Memory', sections: [
      { label: 'What your Inhouse agent knows about you', rows: forgetRows(memory.personal) },
      { label: 'Privacy', rows: [R('Only you can see this', 'Teammates and admins cannot read your personal memory.', 'value', 'Private'), R('Learn from my chats', 'Your Inhouse agent saves your preferences as you work. Turn off to stop.', 'toggle', '', 0, 'm:learn', true)] },
    ] },
    // Stage 1 M2-H: the list of what the agent may do without asking (Permissions.tsx draws it). Its words here are for
    // the settings search.
    'you-permissions': { title: 'Always allowed', sections: [], keywords: 'permissions always allow without asking remove stop allowing' },
    // Stage 1 M3-C: Ceiling.tsx draws it (the product only); named here for the search.
    'team-ceiling': { title: 'What the agent can do', sections: [], keywords: 'ceiling limits actions writes switch on off inhouse team per day batch' },
    'team-agent': { title: 'Inhouse agent', sections: [
      { label: 'About', rows: [
        txt('Brand name', 'Shown in the sidebar and in requests to your Inhouse team.', 'b:name', meta.brand.name),
        ...demoOnly(sel('Tone', 'How it writes to suppliers, customers and your team.', 't:tone', meta.agent.tone, ['Friendly and short', 'Warm and detailed', 'Formal and brief', 'Plain and direct']), txt('Signs emails as', 'Used on supplier and customer emails.', 't:signs', meta.agent.signsEmailsAs)),
      ] },
      { label: 'Answers', rows: [
        sel('Most steps in one answer', 'An answer that needs more steps than this stops and says so.', 't:max_turns', '25', [...MAX_TURNS]),
        // The two web switches are an Admin's (brand settings, M1-F); which websites it may open stays the Inhouse team's.
        { ...R('Search the web', 'Let your Inhouse agent search the web. Off by default.', 'toggle', '', 0, 't:websearch', false), keywords: 'websearch internet' },
        { ...R('Read web pages', 'Let your Inhouse agent open the websites listed below. Off blocks them all.', 'toggle', '', 0, 't:webfetch_on', true), keywords: 'webfetch internet websites' },
        { ...txt('Websites it may open', 'Enter one website name per line. Leave empty to block all websites.', 't:webfetch', ''), type: 'hosts', keywords: 'webfetch hosts domains allowlist' },
      ] },
      { label: 'What your Inhouse agent knows', rows: [R('Team memory', `Supplier, customer and stock rules the whole team shares. ${memCount} things remembered.`, 'button', 'Open memory', 0, undefined, undefined, () => env.openSettings('team-memory')), R('Skills', `The jobs it knows how to do. ${skills.length} skills, added by your Inhouse team.`, 'button', 'View skills', 0, undefined, undefined, env.goSkills)] },
    ] },
    'team-modes': { title: 'Models', sections: [
      { label: '', caption: 'How hard it thinks', rows: modeRows },
      { label: '', rows: [sel('Default model', '', 'g:mode', defaultMode, modeLabels)] },
    ] },
    'team-memory': { title: 'Team memory', sections: [
      ...waitingMem,
      ...teamMem,
      { label: 'How your Inhouse agent learns', rows: [R('Ask before saving a team rule', 'On: new and changed team rules wait until an admin approves them. Off: they count at once.', 'toggle', '', 0, 'm:ask', true), teach] },
    ] },
    'team-members': { title: 'Members', sections: [
      { label: team.length === 1 ? '1 person' : `${team.length} people`, rows: [...team.map(m => {
        const first = m.name.split(' ')[0]
        return withAvatar({ ...SEL(m.name, [m.email, m.title].filter(Boolean).join(' · '), `p:${m.id}`, m.role === 'admin' ? 'Admin' : 'Member', ['Admin', 'Member']), tag: m.status === 'invited' ? 'Invited' : undefined, tagVariant: 'muted', can: 'changeRole', save: v => env.setRole(m.id, v === 'Admin' ? 'admin' : 'member'), confirm: v => removesAdmin(m, v),
          remove: m.id === me.id || (env.me?.role === 'inhouse' && m.role === 'admin') ? undefined : { label: `Remove ${m.name}`, title: `Remove ${m.name}?`, text: `${first} loses access to Inhouse. The audit log keeps what ${first} did.`, action: 'Remove', go: () => env.removeMember(m.id) } }, m.id)
      }), { ...R('Invite someone', 'They sign in with their work email.', 'button', 'Invite', 0, undefined, undefined, env.invite), can: 'invite' }] },
    ] },
    'team-spend': { title: 'Spending cap', sections: [
      { label: 'This month', rows: [{ ...txt('Monthly cap', 'Chats, routines and jobs pause when the cap is reached.', 's:cap', fmtCapSetting(usage.cap, d0)), type: 'money' }, { ...txt('Job budget', `A long job stops once it has spent this. It can go a little over. Up to ${fmtMoney(moneyOf(MAX_JOB_BUDGET_USD, FIELD_CURRENCY), d0)}.`, 's:job_cap', fmtMoney(moneyOf(DEFAULT_JOB_BUDGET_USD, FIELD_CURRENCY), d0, { grouping: false })), type: 'jobBudget', keywords: 'job budget per job max' }, sel('Alert at', 'Admins get an email.', 's:alert', `${usage.alertAt}%`, ['50%', '70%', '80%', '90%', '100%']), sel('Show amounts in', 'The currency used for amounts in reports and emails.', 's:currency', 'USD ($)', ['USD ($)', 'GBP (£)', 'EUR (€)', 'CAD ($)', 'AUD ($)']), R('Spent so far', `${usage.month} ${usage.monthKey?.slice(0, 4) ?? calendarOf(now, d0).year}.`, 'value', fmtSpentSetting(env.spent, d0))] },
      // The one stop for everything at once, next to the cap that stops it by itself.
      // Pause and Resume are Admin and Inhouse team only (access-matrix rows 36 and 37). `editBrandSettings` is the `me().can` key
      // with the same class and allow list (row 10, pause-can.test.ts); a Member sees no button instead of one the server refuses.
      { label: 'Pause', rows: [{ ...R('Pause Inhouse agent', 'Stops every chat, routine and job at once.', 'button', agent.paused ? 'Resume Inhouse agent' : 'Pause Inhouse agent', 1, undefined, undefined, env.togglePause), can: 'editBrandSettings' as const }] },
      { label: 'Accounts', rows: [R('AI', 'Your Anthropic account, billed at cost.', 'value', 'Anthropic'), R('Hosting', 'Your Cloudflare account, billed at cost.', 'value', 'Cloudflare')] },
    ] },
    'team-data': { title: 'Data and access', sections: [
      { label: 'Where your data stays', rows: [R('Your tools', 'Orders, customers and money stay in your own tools. Your Inhouse agent reads what a job needs.', 'value', 'Stays in each tool'), R('Inhouse agent', 'Chats, memory, routines and logs are stored on your own Cloudflare account.', 'value', 'Your Cloudflare'), R('AI models', 'Questions go to Anthropic through your own account.', 'value', 'Your Anthropic')] },
      { label: 'How long things are kept', rows: [sel('Chats', `Older chats are deleted automatically.${setByTeam}`, 'd:chats', '12 months', RETENTION), sel('Activity and steps', `Every step it took, kept for checking later.${setByTeam}`, 'd:steps', '12 months', RETENTION), R('Next cleanup', 'Anything older than these periods is deleted then.', 'value', nextCleanup), R('Audit log', 'Changes to settings, rules and people. Cannot be shortened.', 'value', '12 months')] },
      { label: 'Who can get in', rows: [R('Your team', 'People sign in with their work email.', 'value', team.length === 1 ? '1 member' : `${team.length} members`), ...(env.showGrant ? [supportRow] : []), ...demoOnly(R('Two-step sign-in', 'Everyone confirms with a code when they sign in.', 'toggle', '', 0, 'd:2fa', true))] },
      { label: 'Take it with you', rows: [{ ...R('Export everything', 'Chats, files, memory, routines, skills, settings and logs in one file. It downloads as it is gathered, which can take a few minutes.', 'button', 'Export', 0, undefined, undefined, exportEverything), can: 'exportData' as const }, R('Delete Inhouse agent and its data', 'Removes chats, memory and logs from your Cloudflare account. Your tools are not touched.', 'button', 'Ask the team', 0, undefined, undefined, () => env.openTeam('change', brandName ? `Please delete the Inhouse agent and its data for ${brandName}.` : 'Please delete the Inhouse agent and its data.'))] },
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
  // P5 W4: built only when it's asked for, from what Settings.tsx read.
  if (tab === 'team-slack' && hasSlack(data.tools)) return slackPage(env.notify, env.product, env.me?.role ?? null, env.openSettings)
  // A page the product leaves out never renders, even for the frame before a deep link to it is redirected (App.tsx).
  return Object.hasOwn(pages, tab) && pageShown(tab, env.product) ? pages[tab] : pages['you-general']
}
