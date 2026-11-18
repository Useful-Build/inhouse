// Settings: menu on the left, content on the right.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'
import { agent } from '../agent'
import { STAGE_TAGS, memberFor, userName } from '../state/derive'
import { backToSettingsMenu, useCtx, useUi } from '../state/store'
import { Avatar, Button, Icon, IconButton, NavItem, PageHeader, SectionHeader, StageTag, Switch } from '../ui'
import { Confirm, SearchBox, Select, TAP } from '../ui/fields'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { PHOTO_MAX_BYTES, PHOTO_TYPES, PhotoDecodeError, squarePhoto } from '../ui/photo'
import { MENU, checkField, settingsPage } from './settings/content'
import { useTheme } from '@/lib/theme'
import type { Env, FieldType, Row } from './settings/content'

/** Upload and Remove for a person's photo. Saved through the agent, so every avatar updates at once. */
function PhotoControl({ personId, locked }: { personId: string; locked: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const showToast = useUi(s => s.showToast)
  const pick = async (file: File | undefined) => {
    if (!file) return
    if (!PHOTO_TYPES.includes(file.type)) return showToast('Use a PNG, JPG or WebP image.', { icon: 'info' })
    if (file.size > PHOTO_MAX_BYTES) return showToast('That image is over 5 MB. Choose a smaller one.', { icon: 'info' })
    try { agent.setPhoto(personId, await squarePhoto(file)) }
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
      <Button variant="outline" disabled={locked} onClick={() => agent.setPhoto(personId, null)} size="lg">Remove</Button>
    </div>
  )
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
    : <Input {...fieldProps(row, disabled)} value={row.value} onChange={e => { agent.setSetting(row.key!, e.target.value); toastSaved() }} />
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
    agent.setSetting(row.key!, r.value)
    // Saved once, not while typing, so it says so straight away.
    useUi.getState().showToast('Saved', { icon: 'check', ms: 2000, key: 'saved' })
  }
  return (
    <div className="flex max-w-full flex-col items-end gap-1.5">
      <Input {...common} value={draft} inputMode={type === 'money' ? 'decimal' : 'email'} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={e => { setDraft(e.target.value); if (error) setError(null) }}
        onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }} />
      {error && <p id={errorId} className="m-0 w-55 max-w-full text-sm text-destructive-text">{error}</p>}
    </div>
  )
}

function Control({ row, locked, on, onToggle, onAsk, readOnly }: { row: Row; locked: boolean; on: boolean; onToggle: () => void; onAsk: (a: Ask) => void; readOnly: boolean }) {
  // A team setting on a phone is read, not changed (D4): the value as text, no control. A button only opens something
  // (the team window, a page) or does a job (pause, forget, export), so it keeps working.
  if (readOnly && row.kind !== 'button' && row.kind !== 'photo') {
    const shown = row.kind === 'toggle' ? (on ? 'On' : 'Off')
      : row.kind === 'mode' ? `Thinks ${row.value.toLowerCase()} · ${row.switchOn ? 'team can use it' : 'team can\'t use it'}`
      : row.kind === 'select' ? `${row.labels?.[row.value] ?? row.value}${row.tag ? ` · ${row.tag}` : ''}`
      : row.value
    return shown ? <span className="text-right text-base text-foreground-2">{shown}</span> : null
  }
  switch (row.kind) {
    case 'select': {
      const save = (v: string) => { agent.setSetting(row.key!, v); row.onChange?.(v) }
      // A row with labels shows them and saves the value behind the one picked (an unknown saved value shows as it is).
      const shown = (v: string) => row.labels?.[v] ?? v
      const valueOf = (label: string) => Object.keys(row.labels ?? {}).find(k => row.labels![k] === label) ?? label
      const select = <Select label={row.title} value={shown(row.value)} options={(row.options ?? []).map(shown)} disabled={locked || !row.key} onChange={l => {
        const v = valueOf(l)
        const q = row.confirm?.(v)
        if (q) onAsk({ ...q, go: () => save(v) })
        else save(v)
      }} />
      return row.tag
        ? <span className="inline-flex flex-wrap items-center justify-end gap-2.5"><Badge variant="warning">{row.tag}</Badge>{select}</span>
        : select
    }
    case 'text':
      return <TextField row={row} disabled={locked || !row.key} />
    case 'value':
      return row.value ? <span className="text-right text-base text-foreground-2">{row.value}</span> : null
    case 'button':
      return <Button variant="outline" disabled={locked || !row.onClick} onClick={row.onClick} size="lg">{row.value}</Button>
    case 'toggle':
      return <Switch on={on} label={row.title} onChange={locked ? undefined : onToggle} />
    case 'mode':
      return (
        <div className="flex flex-wrap items-center gap-4.5">
          {/* The one visible label for the effort pickers, on the first row only. */}
          <div className="flex flex-col gap-1">
            {row.caption && <span className="text-xs text-muted-foreground">{row.caption}</span>}
            <Select label={`How hard ${row.title} thinks`} value={row.value} options={row.options ?? []} onChange={v => agent.setSetting(row.key!, v)} />
          </div>
          {/* The switch's visible label: whether the team can use this model. */}
          <span className="inline-flex h-9.5 items-center gap-2">
            <Switch on={!!row.switchOn} label={`${row.title}: the team can use this model`} reason={row.switchTip} onChange={() => agent.setSetting(row.switchKey!, row.switchOn ? 'off' : null)} />
            <span aria-hidden="true" className="w-6 text-sm text-foreground-3">{row.switchOn ? 'On' : 'Off'}</span>
          </span>
        </div>
      )
    case 'photo':
      return <PhotoControl personId={row.avatar!.who} locked={locked} />
  }
}

/** Saves a file from the browser. */
function download(file: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = file
  document.body.append(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Settings() {
  const ctx = useCtx()
  const { S, agent: st, data } = ctx
  const { usage } = data
  const ui = useUi()
  const { setTab, phone, stage } = ui
  const contentRef = useRef<HTMLDivElement>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  // A "Saved" still waiting for typing to stop doesn't follow the person off the page.
  useEffect(() => () => clearTimeout(savedTimer), [])
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

  const pick = (k: string) => ui.patch({ setTab: k, setMenu: false })
  const { theme, setTheme } = useTheme()
  const env: Env = {
    S, stage, agent: st, data,
    spent: usage.total,
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
  }
  const page = settingsPage(setTab, env)
  const readOnly = phone && setTab.startsWith('team-')

  // Search: a menu page matches by its name, or by the name or text of any row on it.
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const found = (() => {
    if (!needle) return null
    const hits = new Map<string, string[]>()
    for (const g of MENU) for (const [k, , label] of g.items) {
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
        {MENU.map(g => {
          const items = g.items.filter(([k]) => !found || found.has(k))
          if (items.length === 0) return null
          return (
            <div key={g.label}>
              <div className="px-3 pt-5 pb-1.5 text-xs font-medium text-muted-foreground">{g.label}</div>
              {items.map(([k, icon, label]) => {
                const sel = setTab === k
                const rows = found?.get(k) ?? []
                return (
                  <NavItem key={k} data-nav-row icon={icon} label={label} size={phone ? 'tap' : 'fit'} active={sel && !phone}
                    detail={rows.length > 0 ? rows.join(' · ') : undefined} onClick={() => pick(k)} />
                )
              })}
            </div>
          )
        })}
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
          {readOnly && (
            <p role="note" className="mt-3 flex items-center gap-2 text-sm text-foreground-3">
              <Icon name="desktop_windows" size={16} className="flex-none" />Change team settings on a computer. You can read them here.
            </p>
          )}
          {page.sections.filter(sec => sec.rows.length > 0).map((sec, si) => (
            <section key={`${si}|${sec.label}`} className={sec.label ? undefined : 'mt-4.5'}>
              {sec.label && <SectionHeader title={sec.label} className="mt-6 mb-2.5" />}
              <div className="rounded-2xl border border-border bg-card px-5.5">
                {sec.rows.map((row, i) => {
                  const locked = S < row.need
                  const on = !locked && (st.toggles[row.key ?? ''] ?? row.def ?? false)
                  return (
                    <div key={`${row.title}|${i}`} className={`flex flex-wrap items-center gap-x-6 gap-y-3 py-4 ${i === 0 ? '' : 'border-t border-divider'}`}>
                      <div className="flex min-w-0 grow basis-65 items-center gap-3.5">
                        {row.avatar?.at === 'row' && memberFor(data, row.avatar.who, userName(ctx)) && <span className={cn('flex flex-none', locked && 'grayscale')}><Avatar who={row.avatar.who} size={row.kind === 'photo' ? 48 : 36} /></span>}
                        <div className="min-w-0 flex-1">
                          <div className={`flex items-center gap-2 text-md font-strong ${locked ? 'text-foreground-3' : ''}`}>{row.title}{locked && <StageTag tag={STAGE_TAGS[row.need]} />}</div>
                          {row.desc && <div className="mt-0.5 text-sm text-pretty text-muted-foreground">{row.desc}</div>}
                        </div>
                      </div>
                      {row.avatar?.at === 'control' && memberFor(data, row.avatar.who, userName(ctx)) && <span className={cn('flex flex-none', locked && 'grayscale')}><Avatar who={row.avatar.who} size={28} fontSize={11} /></span>}
                      <Control readOnly={readOnly} row={row} locked={locked} on={on} onToggle={() => agent.setToggle(row.key!, !on)} onAsk={setAsk} />
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
      )}
      {ask && (
        <Confirm label={ask.title} title={ask.title} action={ask.action} onCancel={() => setAsk(null)} onConfirm={() => { ask.go(); setAsk(null) }}>
          {ask.text}
        </Confirm>
      )}
    </div>
  )
}
