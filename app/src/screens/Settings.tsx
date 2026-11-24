// Settings: menu on the left, content on the right.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { agent, demo } from '../agent'
import { STAGES } from '../agent/types'
import type { SupportGrant } from '../agent'
import { keepUnitsTogether } from '../agent/clock'
import { STAGE_TAGS, memberFor, userName } from '../state/derive'
import { backToSettingsMenu, useCtx, useUi } from '../state/store'
import { Avatar, Button, EmptyState, Icon, IconButton, InhouseMark, NavItem, PageHeader, SectionHeader, StageTag, Switch, SwitchLook } from '../ui'
import { Confirm, SearchBox, Select, TAP } from '../ui/fields'
import { Badge } from '@/components/ui/badge'
import { GRANT_HOURS } from '../../shared/contract/keys'
import { LoadError } from '../ui/retry'
import { InviteDialog } from './settings/InviteDialog'
import { allowance, mayEditNotify, pageResources, showsRemove } from './settings/allowance'
import { readParts } from './settings/read-text'
import { single } from './settings/single'
import { tell } from './settings/write'
import { useNotifyChannels } from './settings/notify-channels'
import { waitingList } from './settings/waiting-list'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PHOTO_MAX_BYTES, PHOTO_TYPES, PhotoDecodeError, squarePhoto } from '../ui/photo'
import { checkField, hasSlack, menuFor, settingsPage } from './settings/content'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme } from '@/lib/theme'
import { saveBlob } from '@/lib/save-file'
import type { Env, FieldType, Row } from './settings/content'

/** Upload and Remove for a person's photo. Saved through the agent, so every avatar updates at once. */
function PhotoControl({ personId, locked }: { personId: string; locked: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const showToast = useUi(s => s.showToast)
  const pick = async (file: File | undefined) => {
    if (!file) return
    if (!PHOTO_TYPES.includes(file.type)) return showToast('Use a PNG, JPG or WebP image.', { icon: 'info' })
    if (file.size > PHOTO_MAX_BYTES) return showToast('That image is over 5 MB. Choose a smaller one.', { icon: 'info' })
    try { tell(agent.setPhoto(personId, await squarePhoto(file))) }
    catch (e) {
      if (e instanceof PhotoDecodeError) return showToast("That file isn't a readable image.", { icon: 'info' })
      console.error('Inhouse: could not add the photo.', e)
      showToast("Couldn't add the photo.", { icon: 'info' })
    }
  }
  return (
    <div className="flex gap-2">
      <input ref={input} type="file" accept={PHOTO_TYPES.join(',')} aria-label="Photo file" hidden
        onChange={e => { void pick(e.target.files?.[0]); e.target.value = '' }} />
      <Button variant="outline" disabled={locked} onClick={() => input.current?.click()} size="lg">Upload</Button>
      <Button variant="outline" disabled={locked} onClick={() => tell(agent.setPhoto(personId, null))} size="lg">Remove</Button>
    </div>
  )
}

const RESOURCE_NAMES: Record<string, string> = {
  members: 'the team', rules: 'the approval rules', audit: 'the audit log', grants: 'who can get in', memory: 'what your Inhouse agent remembers',
}

/** A question waiting before a setting is saved. */
interface Ask { title: string; text: string; action: string; go: () => void }

let savedTimer: ReturnType<typeof setTimeout> | undefined
/** A small "Saved" toast once typing stops, not one per keystroke. */
const toastSaved = () => {
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => useUi.getState().showToast('Saved', { icon: 'check', ms: 2000, key: 'saved' }), 600)
}

const FIELD = 'box-border h-9.5 w-55 max-w-full rounded-lg bg-card px-3.25 text-base text-foreground shadow-none focus-visible:border-foreground/45 focus-visible:shadow-halo focus-visible:ring-0 md:text-base'

const fieldProps = (row: Row, disabled: boolean): ComponentProps<typeof Input> =>
  ({ type: 'text', 'aria-label': row.title, disabled, autoComplete: 'off', spellCheck: false, className: FIELD })

/**
 * A settings text field. A plain field saves as you type. A typed one (an amount, an email) is checked when it loses
 * focus or on Enter: a wrong value shows why under the field and isn't saved; a right one is saved, in its tidy form.
 */
function TextField({ row, disabled }: { row: Row; disabled: boolean }) {
  return row.type
    ? <TypedField key={row.key} row={row} type={row.type} disabled={disabled} />
    : <PlainField row={row} disabled={disabled} />
}

/**
 * A plain field saves as you type. The registry refuses an empty value and one over 80 characters (the name and the
 * sign-off), so those aren't saved: the field says why and keeps what was typed.
 */
function PlainField({ row, disabled }: { row: Row; disabled: boolean }) {
  const [draft, setDraft] = useState(row.value)
  const [saved, setSaved] = useState(row.value)
  if (saved !== row.value) { setSaved(row.value); setDraft(row.value) }
  const error = !draft.trim() ? "This can't be empty." : draft.length > 80 ? 'Use 80 characters or fewer.' : null
  const errorId = `field-error-${row.key}`
  return (
    <div className="flex max-w-full flex-col items-end gap-1.5">
      <Input {...fieldProps(row, disabled)} value={draft} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={e => {
          setDraft(e.target.value)
          if (e.target.value.trim() && e.target.value.length <= 80) { tell(agent.setSetting(row.key!, e.target.value), row); toastSaved() }
        }} />
      {error && <p id={errorId} className="m-0 w-55 max-w-full text-sm text-destructive-text">{error}</p>}
    </div>
  )
}

function TypedField({ row, type, disabled }: { row: Row; type: FieldType; disabled: boolean }) {
  const [draft, setDraft] = useState(row.value)
  const [error, setError] = useState<string | null>(null)
  // A change to the saved value from outside (Reset demo, another tab, the tidy form of what was typed) shows, and the
  // field keeps focus, so Enter can save and stay in place.
  const [saved, setSaved] = useState(row.value)
  if (saved !== row.value) { setSaved(row.value); setDraft(row.value); setError(null) }
  const common = fieldProps(row, disabled)
  const errorId = `field-error-${row.key}`
  const commit = () => {
    const r = checkField(type, draft)
    if ('error' in r) { setError(r.error); return }
    setError(null)
    if (r.value === row.value) { setDraft(r.value); return }
    tell(agent.setSetting(row.key!, r.value), row)
    // Saved once, not while typing, so it says so straight away.
    useUi.getState().showToast('Saved', { icon: 'check', ms: 2000, key: 'saved' })
  }
  return (
    <div className="flex max-w-full flex-col items-end gap-1.5">
      {type === 'hosts'
        // A list: Enter adds a line, and the list is checked when the field loses focus.
        ? <Textarea aria-label={row.title} disabled={disabled} autoComplete="off" spellCheck={false} rows={4} value={draft} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            className="box-border w-55 max-w-full rounded-lg bg-card px-3.25 py-2 text-base text-foreground shadow-none focus-visible:border-foreground/45 focus-visible:shadow-halo focus-visible:ring-0 md:text-base"
            onChange={e => { setDraft(e.target.value); if (error) setError(null) }} onBlur={commit} />
        : <Input {...common} value={draft} inputMode={type === 'money' ? 'decimal' : 'email'} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
            onChange={e => { setDraft(e.target.value); if (error) setError(null) }}
            onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />}
      {error && <p id={errorId} className="m-0 w-55 max-w-full text-sm text-destructive-text">{error}</p>}
    </div>
  )
}

/** A team setting's value as text, on a phone: on its own line under the row's description, whatever the kind. */
function ReadValue({ row, on }: { row: Row; on: boolean }) {
  // A part never breaks inside, and the dot goes with the part after it, so no line starts or ends on a stranded dot.
  const parts = (p: string[]) => p.map((t, i) => <span key={t} className="whitespace-nowrap">{i > 0 && '\u00b7 '}{t}</span>).flatMap((e, i) => i > 0 ? [' ', e] : [e])
  const text = readParts(row, on)
  const shown = typeof text === 'string' ? text : parts(text)
  return shown ? <div className="mt-1.5 text-base text-pretty text-foreground-2">{shown}</div> : null
}

/** A description whose every separator dot is held to the word before it, so a line never starts with one. */
function descNode(desc: string) {
  return keepUnitsTogether(desc).replaceAll(' \u00b7 ', '\u00a0\u00b7 ')
}

/** Gives, and ends, the Inhouse team's access (BD7): none, live until a time, or ended; Grant for 1, 4, 24 or 72 hours; End now. */
function GrantControl({ row, grant }: { row: Row; grant: SupportGrant | null }) {
  const [hours, setHours] = useState('24 hours')
  const label = (h: number) => `${h} ${h === 1 ? 'hour' : 'hours'}`
  // One request at a time: a second click while Grant or End now is saving does nothing.
  const [busy, setBusy] = useState(false)
  const run = useRef(single((start: () => Promise<unknown>) => { const p = start(); tell(p); return p }, setBusy)).current
  return (
    <div className="flex flex-wrap items-center justify-end gap-2.5">
      <span className="text-base text-foreground-2">{row.value}</span>
      {grant?.live
        ? <Button variant="outline" size="lg" disabled={busy} onClick={() => run(() => agent.endSupportGrant(grant.id))}>End now</Button>
        : (
          <>
            <Select label="Give access for" value={hours} options={GRANT_HOURS.map(label)} onChange={setHours} minWidth={110} />
            <Button variant="outline" size="lg" disabled={busy} onClick={() => run(() => agent.grantSupport(GRANT_HOURS.find(h => label(h) === hours)!))}>Grant</Button>
          </>
        )}
    </div>
  )
}

function Control({ row, locked, on, onToggle, onAsk, readOnly, denied, effortOk, switchOk, grant, caption }: { row: Row; locked: boolean; on: boolean; onToggle: () => void; onAsk: (a: Ask) => void; readOnly: boolean; denied: boolean; effortOk: boolean; switchOk: boolean; grant: SupportGrant | null; caption?: string }) {
  // A button, action or photo upload the person's role doesn't allow isn't offered (S5).
  if (denied && (row.kind === 'button' || row.kind === 'grant' || row.kind === 'photo')) return null
  // A team setting on a phone is read, not changed (D4): its value shows as text under the description (see ReadValue).
  if (readOnly && row.kind !== 'button' && row.kind !== 'photo') return null
  switch (row.kind) {
    case 'select': {
      const save = (v: string) => { if (row.save) row.save(v); else tell(agent.setSetting(row.key!, v), row); row.onChange?.(v) }
      // A row with labels shows them and saves the value behind the one picked (an unknown saved value shows as it is).
      const shown = (v: string) => row.labels?.[v] ?? v
      const valueOf = (label: string) => Object.keys(row.labels ?? {}).find(k => row.labels![k] === label) ?? label
      const select = <Select label={row.title} value={shown(row.value)} options={(row.options ?? []).map(shown)} disabled={locked || !row.key} display={row.display} onChange={l => {
        const v = valueOf(l)
        const q = row.confirm?.(v)
        if (q) onAsk({ ...q, go: () => save(v) })
        else save(v)
      }} />
      return row.tag
        ? <span className="inline-flex flex-wrap items-center justify-end gap-2.5"><Badge variant={row.tagVariant ?? 'warning'}>{row.tag}</Badge>{select}</span>
        : select
    }
    case 'text':
      return <TextField row={row} disabled={locked || !row.key} />
    case 'value':
      return row.value ? <span className="text-right text-base text-foreground-2">{row.value}</span> : null
    case 'button':
      return <Button variant="outline" aria-label={row.ariaLabel} disabled={locked || !row.onClick || row.busy} onClick={row.onClick} size="lg">{row.value}</Button>
    case 'toggle':
      return <Switch on={on} label={row.title} onChange={locked ? undefined : onToggle} />
    case 'mode':
      return (
        <div className="flex flex-wrap items-center gap-4.5 @xl:flex-nowrap">
          {/* The visible words are in the name ("How hard it thinks: Smart"), so a voice command by label works. */}
          <div className="flex flex-col gap-1.5">
            {/* Below the card's @xl width the rows wrap and the section's top caption is hidden, so the first picker carries it. */}
            {caption && <span className="text-xs text-muted-foreground @xl:hidden">{caption}</span>}
            <Select label={`How hard it thinks: ${row.title}`} value={row.value} options={row.options ?? []} onChange={v => tell(agent.setSetting(row.key!, v), row)} disabled={!effortOk} />
          </div>
          {/* The switch's visible label: whether the team can use this model. */}
          <span className="inline-flex h-9.5 items-center gap-2">
            <Switch on={!!row.switchOn} label={`${row.title}: the team can use this model`} reason={row.switchTip} onChange={switchOk ? () => tell(agent.setSetting(row.switchKey!, row.switchOn ? 'off' : 'on'), row) : undefined} />
            <span aria-hidden="true" className="w-6 text-sm text-foreground-3">{row.switchOn ? 'On' : 'Off'}</span>
          </span>
        </div>
      )
    case 'grant':
      return <GrantControl row={row} grant={grant} />
    case 'photo':
      return <PhotoControl personId={row.avatar!.who} locked={locked} />
  }
}

/** The Inhouse team's mark, round and the size of a person's avatar, for a line the team wrote. */
const isTeam = (who: string) => who.includes('Inhouse team')
const TeamMark = () => <span aria-hidden="true" className="flex size-9 items-center justify-center rounded-full bg-fill"><InhouseMark size={16} /></span>

/** Saves a file from the browser. */
function download(file: string, text: string, type: string) {
  saveBlob(file, new Blob([text], { type }))
}

export function Settings() {
  const ctx = useCtx()
  const { S, agent: st, data } = ctx
  const { usage } = data
  const ui = useUi()
  const { setTab, phone } = ui
  const stage = STAGES[S]
  const me = useSyncExternalStore(agent.subscribe, agent.me)
  const [inviting, setInviting] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const more = useRef(single((list: 'audit' | 'members') => agent.loadMore(list), setLoadingMore)).current
  // The grant (route 16) is for an Admin and the Inhouse team; the demo shows its switch to everyone. Until `me()` loads the product shows none.
  const showGrant = demo !== null || (!!me && (me.can.grantSupport || me.role === 'inhouse'))
  const contentRef = useRef<HTMLDivElement>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  // A "Saved" still waiting for typing to stop doesn't follow the person off the page.
  useEffect(() => () => clearTimeout(savedTimer), [])
  // A Memory page re-reads memory when it opens: what the agent saved since the app started isn't in the first read.
  const readsMemory = pageResources(setTab, false).includes('memory')
  useEffect(() => { if (readsMemory) agent.refreshMemory().catch(() => undefined) }, [readsMemory, setTab])
  // P6a: Team memory reads what waits for an OK when it opens, for someone who may approve. Unread (or refused): no section.
  const approves = setTab === 'team-memory' && !!me?.can.approveMemory
  const [waitingStore] = useState(() => waitingList({
    waitingMemory: () => agent.waitingMemory(),
    reviewMemory: (key, approved) => agent.reviewMemory(key, approved),
    refreshMemory: () => agent.refreshMemory(),
    toast: (text, opts) => ui.showToast(text, opts),
  }))
  const waitingState = useSyncExternalStore(waitingStore.subscribe, waitingStore.get)
  // The list shows only while `approves` (see `waiting` in env), so leaving the page needs no reset here.
  useEffect(() => { if (approves) void waitingStore.open() }, [approves, waitingStore])
  // Phone: the menu alone, or the picked page alone with Back to the menu (the store forgets which when Settings is left).
  const atMenu = phone && ui.setMenu
  // A new screen starts at its top.
  useLayoutEffect(() => {
    if (!phone) return
    const main = document.querySelector('main')
    if (main) main.scrollTop = 0
  }, [phone, atMenu, setTab])

  // Desktop: the page content scrolls in its own area, and each settings page keeps its own scroll position.
  const positions = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    if (phone || !contentRef.current) return
    contentRef.current.scrollTop = positions.current.get(setTab) ?? 0
  }, [setTab, phone])

  // P5 W4: the Slack notices page reads its channels while it's open; an Admin or the Inhouse team also reads the picker.
  const notify = useNotifyChannels(setTab === 'team-slack' && hasSlack(data.tools), mayEditNotify(me?.can))
  const pick = (k: string) => ui.patch({ setTab: k, setMenu: false })
  const { theme, setTheme } = useTheme()
  // Export everything's check-then-download, one at a time: a second click while route 96 is still planning shares the
  // first click's promise, so it never starts a second export (and a second audit line).
  const exportInFlight = useRef<Promise<void> | null>(null)
  const env: Env = {
    S, stage, agent: st, data,
    spent: usage.total,
    phone,
    openTeam: ui.openTeam, openPop: ui.openPop, openSettings: ui.openSettings, newChat: ui.newChat,
    goSkills: () => ui.go('skills'),
    togglePause: ui.togglePause,
    theme, setTheme,
    toast: (text, ms, icon) => ui.showToast(text, { ms, icon }),
    forget: key => {
      agent.forgetMemory(key, true)
      ui.showToast('Forgotten. Your Inhouse agent will no longer use this.', { undo: () => { agent.forgetMemory(key, false); ui.clearToast() } })
    },
    download,
    setRole: (id, role) => { tell(agent.setMemberRole(id, role)) },
    setSupport: (on, grantId) => { tell(on ? agent.grantSupport(24) : agent.endSupportGrant(grantId ?? '')) },
    me,
    invite: () => setInviting(true),
    removeMember: id => {
      const m = data.people.members.find(x => x.id === id)
      const named = data.people.approvalRules.filter(r => r.approver === id).length
      agent.removeMember(id).then(() => {
        // A removed person stays named on the rules that chose them (tagged "Not an approver"), so say so.
        if (m && named > 0) ui.showToast(`${m.name.split(' ')[0]} is still named on ${named} approval ${named === 1 ? 'rule' : 'rules'}.`, { ms: 7000 })
      }, (e: unknown) => { tell(Promise.reject(e)) })
    },
    // The demo keeps its one switch for Inhouse team access (Data and access looks as it always did); the product shows the grant.
    grantUi: demo === null,
    showGrant,
    loadingMore,
    loadMore: list => { more(list) },
    exportFromServer: agent.auditExportUrl() ? () => { window.location.assign(agent.auditExportUrl()!) } : null,
    // Route 96 first: a refusal stays in the app (content.ts says why) instead of replacing it with a JSON page. Then route
    // 95 streams its own download (Content-Disposition), so the page stays where it is while the file arrives.
    exportDataFromServer: agent.dataExportUrl() ? () => {
      exportInFlight.current ??= (async () => {
        await agent.checkDataExport()
        window.location.assign(agent.dataExportUrl()!)
      })().finally(() => { exportInFlight.current = null })
      return exportInFlight.current
    } : null,
    notify,
    waiting: approves ? { state: waitingState, decide: waitingStore.decide, retry: () => { void waitingStore.read() } } : undefined,
  }
  const page = settingsPage(setTab, env)
  // P5 W4: Slack notices is listed only for a brand with Slack connected.
  const menu = menuFor(data.tools)
  const readOnly = phone && setTab.startsWith('team-')
  // The note is for a page where a control became text; a page of buttons and plain facts has nothing to explain.
  const hidesControls = readOnly && page.sections.some(sec => sec.rows.some(r => r.kind === 'toggle' || r.kind === 'select' || r.kind === 'text' || r.kind === 'mode'))

  // Search: a menu page matches by its name, or by the name or text of any row on it.
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const found = (() => {
    if (!needle) return null
    const hits = new Map<string, string[]>()
    for (const { id: k, label } of menu.flatMap(sec => sec.pages)) {
      const p = settingsPage(k, env)
      const rows = p.sections.flatMap(sec => sec.rows).filter(r => `${r.title} ${r.desc} ${r.keywords ?? ''}`.toLowerCase().includes(needle)).map(r => r.title)
      const pageHit = `${label} ${p.title}`.toLowerCase().includes(needle)
      if (pageHit || rows.length) hits.set(k, [...new Set(rows)].slice(0, 3))
    }
    return hits
  })()

  return (
    <div className={phone ? 'relative flex min-h-below-topbar flex-wrap content-start' : 'relative flex min-h-0 grow basis-0'}>
      {(!phone || atMenu) && (
      <nav aria-label="Settings" className={`box-border flex-none pt-3.5 ${phone ? 'w-full px-(--app-pad-x) pb-14' : 'w-settings-nav overflow-y-auto pr-3.5 pb-7.5 pl-6'}`}>
        {phone && <PageHeader title="Settings" className="mb-4" />}
        <SearchBox value={query} onChange={setQuery} placeholder="Search settings" label="Search settings" />
        {menu.map(sec => {
          const pages = sec.pages.filter(p => !found || found.has(p.id))
          if (pages.length === 0) return null
          // Brand settings: anyone who can't change them sees a lock on the heading, with the reason in a tooltip.
          const lockedForMe = sec.team && me?.can.editBrandSettings === false
          return (
            <div key={sec.id} role="group" aria-labelledby={`settings-sec-${sec.id}`}>
              <div className="flex items-center gap-1.5 px-3 pt-5 pb-1.5 text-xs font-medium text-muted-foreground">
                <span id={`settings-sec-${sec.id}`}>{sec.label}</span>
                {lockedForMe && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" aria-label="Admins change these" className="flex rounded-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                        <Icon name="lock" size={14} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Admins change these</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {pages.map(({ id: k, icon, label }) => {
                const sel = setTab === k
                const rows = found?.get(k) ?? []
                return (
                  <NavItem key={k} data-nav-row icon={icon} iconWeight={400} label={label} size={phone ? 'tap' : 'fit'} active={sel && !phone}
                    detail={rows.length > 0 ? rows.join(' · ') : undefined} onClick={() => pick(k)} />
                )
              })}
            </div>
          )
        })}
        {/* The search field's own Clear button takes it back to the full menu. */}
        {found && found.size === 0 && <p role="status" className="mx-3 mt-6 text-sm text-foreground-3">No settings match "{query.trim()}".</p>}
      </nav>
      )}
      {!atMenu && (
      <div ref={contentRef} onScroll={phone ? undefined : () => { positions.current.set(setTab, contentRef.current!.scrollTop) }}
        className={`box-border min-w-0 px-(--app-pad-x) pt-3.5 pb-14 ${phone ? 'grow basis-full' : 'grow basis-0 overflow-y-auto'}`}>
        <div className="mx-auto max-w-page-narrow">
          {phone
            ? (
              <div className="mb-1 flex items-center gap-1.5">
                <IconButton icon="arrow_back" label="Back to settings" onClick={backToSettingsMenu} className={cn('-ml-2 flex-none', TAP)} />
                <PageHeader title={page.title} className="min-w-0 flex-1" />
              </div>
            )
            : <PageHeader title={page.title} className="mb-1" />}
          {pageResources(setTab, showGrant).filter(k => data.resources[k].status === 'error').map(k => (
            <LoadError key={k} what={RESOURCE_NAMES[k] ?? k} error={data.resources[k].error} onRetry={() => { agent.retry(k).catch(() => undefined) }} />
          ))}
          {hidesControls && (
            <p role="note" className="mt-3 flex items-center gap-2 text-sm text-foreground-3">
              <Icon name="desktop_windows" size={16} className="flex-none" />Change these on a computer.
            </p>
          )}
          {page.sections.filter(sec => sec.rows.length > 0 || sec.empty).map((sec, si) => (
            <section key={`${si}|${sec.label}`} className={sec.label ? undefined : 'mt-4.5'}>
              {sec.label && <SectionHeader title={sec.label} className="mt-6 mb-2.5" />}
              {sec.empty && <EmptyState>{sec.empty}</EmptyState>}
              {sec.rows.length > 0 && (
              <div className="@container rounded-2xl border border-border bg-card px-5.5">
                {sec.caption && !readOnly && (
                  // One label over the pickers: it mirrors a row's right side (picker, then the switch's width) so it sits over them.
                  <div className="hidden justify-end gap-4.5 pt-4 text-xs text-muted-foreground @xl:flex">
                    <span className="w-37.5 flex-none">{sec.caption}</span>
                    <span aria-hidden="true" className="invisible inline-flex items-center gap-2"><SwitchLook on /><span className="w-6" /></span>
                  </div>
                )}
                {readOnly && sec.caption && <div className="pt-4 text-xs text-muted-foreground">{sec.caption}</div>}
                {sec.rows.map((row, i) => {
                  const locked = S < row.need
                  const on = !locked && (row.on ?? st.toggles[row.key ?? ''] ?? row.def ?? false)
                  // A value shown as text (a team page on a phone) sits under the description, in the title's column.
                  const al = allowance(row, me?.can, demo === null, me?.role)
                  const denied = !al.control
                  const asText = (readOnly || denied) && row.kind !== 'button' && row.kind !== 'photo'
                  return (
                    <div key={`${row.title}|${i}`} className={cn('flex gap-x-6 gap-y-3 py-4', asText ? 'items-start' : 'flex-wrap items-center', row.kind === 'mode' && '@xl:flex-nowrap', i > 0 && 'border-t border-divider')}>
                      <div className={cn('flex min-w-0 grow items-center gap-3.5', asText ? 'basis-0' : 'basis-65')}>
                        {row.avatar?.at === 'row' && (memberFor(data, row.avatar.who, userName(ctx)) || isTeam(row.avatar.who)) && <span className={cn('flex flex-none', locked && 'grayscale')}>{isTeam(row.avatar.who) ? <TeamMark /> : <Avatar who={row.avatar.who} size={row.kind === 'photo' ? 48 : 36} />}</span>}
                        <div className="min-w-0 flex-1">
                          <div className={`flex items-center gap-2 text-md font-strong ${locked ? 'text-foreground-3' : ''}`}>{row.title}{locked && <StageTag tag={STAGE_TAGS[row.need]} />}</div>
                          {row.desc && <div className="mt-0.5 text-sm text-pretty text-muted-foreground">{descNode(row.desc)}</div>}
                          {asText && <ReadValue row={row} on={on} />}
                        </div>
                      </div>
                      {row.avatar?.at === 'control' && memberFor(data, row.avatar.who, userName(ctx)) && <span className={cn('flex flex-none', locked && 'grayscale')}><Avatar who={row.avatar.who} size={28} fontSize={11} /></span>}
                      <Control readOnly={readOnly || denied} denied={denied} effortOk={al.effort} switchOk={al.switch} grant={data.people.supportGrant} row={row} locked={locked} on={on} onToggle={() => (row.toggle ? row.toggle(!on) : tell(agent.setToggle(row.key!, !on), row))} onAsk={setAsk} caption={i === 0 && !readOnly ? sec.caption : undefined} />
                      {row.also && !denied && <Button variant="outline" size="lg" aria-label={row.also.ariaLabel} disabled={row.busy} onClick={() => (row.also!.ask ? setAsk({ ...row.also!.ask, go: row.also!.go }) : row.also!.go())}>{row.also.label}</Button>}
                      {row.remove && showsRemove(row, me?.can) && !readOnly && <Button variant="outline" size="lg" aria-label={row.remove.label} onClick={() => setAsk({ title: row.remove!.title, text: row.remove!.text, action: row.remove!.action, go: row.remove!.go })}>Remove</Button>}
                    </div>
                  )
                })}
              </div>
              )}
            </section>
          ))}
        </div>
      </div>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} memberOnly={me?.role === 'inhouse'} />}
      {ask && (
        <Confirm label={ask.title} title={ask.title} action={ask.action} onCancel={() => setAsk(null)} onConfirm={() => { ask.go(); setAsk(null) }}>
          {ask.text}
        </Confirm>
      )}
    </div>
  )
}
