// Library: every file Inhouse agent made or the team shared, in one place. Left panel for where files come from,
// filter tabs, three views (masonry, grid, list), Select for Download and Delete, and a viewer window.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { agent } from '../agent'
import type { LibraryFile, LibraryKind, LibraryPlace } from '../agent'
import type { LibraryView } from '../state/store'
import { useAgentData, useLibraryFiles, useUi } from '../state/store'
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { Button, CardGrid, EmptyState, Icon, IconButton, MenuItem, NavItem, PageHeader, Segmented, SelectionBar } from '../ui'
import { Confirm, SearchBox, Select, TAP, TAP_ROW } from '../ui/fields'
import { CodeBlock, DocPage, MediaFace, TypeBadge, TypeChip } from './library/Previews'
import { OPEN, openSource } from './library/source'
import { Viewer } from './library/Viewer'

type Tab = 'all' | LibraryKind
const TABS: [Tab, string][] = [['all', 'All'], ['images', 'Images'], ['documents', 'Documents'], ['code', 'Code'], ['media', 'Audio and video'], ['other', 'Other']]
const VIEWS: [LibraryView, string, string][] = [['masonry', 'Masonry', 'view_quilt'], ['grid', 'Grid', 'grid_view'], ['list', 'List', 'view_list']]
type Sort = 'Newest' | 'Oldest' | 'Name' | 'Size'
const SORTS: Sort[] = ['Newest', 'Oldest', 'Name', 'Size']
const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
/** "2.4 KB" in bytes. */
const bytes = (size: string) => {
  const [n, unit] = size.split(' ')
  const b = Number(n) * (UNIT[unit] ?? NaN)
  if (!Number.isFinite(b)) throw new Error(`Library: unreadable size "${size}".`)
  return b
}
const SORT_BY: Record<Sort, (a: LibraryFile, b: LibraryFile) => number> = {
  Newest: (a, b) => b.at.localeCompare(a.at),
  Oldest: (a, b) => a.at.localeCompare(b.at),
  Name: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }),
  Size: (a, b) => bytes(b.size) - bytes(a.size),
}
/** The key of the delete toast: a second delete replaces it, joined. */
const FILE_DELETE = 'library-delete'
/** The last delete and its Undo, so the next delete can join it while its toast is still showing. */
let lastDelete: { ids: string[]; undo: () => void } | null = null
const plural = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`

export function Library() {
  const files = useLibraryFiles()
  const places = useAgentData().library.places
  const phone = useUi(s => s.phone)
  const { showToast, clearToast } = useUi.getState()
  const [place, setPlace] = useState('all')
  const [tab, setTab] = useState<Tab>('all')
  // Kept in the store, so the view survives a reload (decision D7).
  const view = useUi(s => s.libraryView)
  const setView = (v: LibraryView) => useUi.getState().patch({ libraryView: v })
  const [sort, setSort] = useState<Sort>('Newest')
  const [q, setQ] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Record<string, true>>({})
  const [openId, setOpenId] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  const matching = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return files.filter(f => (place === 'all' || f.place === place) && f.name.toLowerCase().includes(needle))
  }, [files, place, q])
  const shown = useMemo(() => matching.filter(f => tab === 'all' || f.kind === tab).sort(SORT_BY[sort]), [matching, tab, sort])
  const count = (k: Tab) => (k === 'all' ? matching.length : matching.filter(f => f.kind === k).length)
  const placeOf = (id: string): LibraryPlace => {
    const p = places.find(x => x.id === id)
    if (!p) throw new Error(`Library: unknown place "${id}".`)
    return p
  }
  const title = place === 'all' ? 'All files' : placeOf(place).name
  const open = files.find(f => f.id === openId)
  const pickedIds = shown.filter(f => picked[f.id]).map(f => f.id)
  // The viewer steps through what the page shows: this tab, place and search, in this order.
  const at = open ? shown.indexOf(open) : -1
  const prevId = at > 0 ? shown[at - 1].id : null
  const nextId = at >= 0 && at < shown.length - 1 ? shown[at + 1].id : null

  // Esc closes the delete question first, then the viewer, then leaves Select mode. Left and Right step the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed in a field, or used on a video or audio player, stay there.
      const inControl = e.target instanceof Element && !!e.target.closest('input, textarea, select, video, audio, [contenteditable]:not([contenteditable="false"])')
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && openId && !confirm && !inControl && !e.altKey && !e.metaKey && !e.ctrlKey) {
        const to = e.key === 'ArrowLeft' ? prevId : nextId
        if (to) { e.preventDefault(); setOpenId(to) }
        return
      }
      if (e.key !== 'Escape') return
      // The delete question listens for its own Escape (Confirm).
      if (confirm) return
      if (openId) setOpenId(null)
      else if (selecting) { setSelecting(false); setPicked({}) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, openId, selecting, prevId, nextId])

  const endSelect = () => { setSelecting(false); setPicked({}) }
  // A pick only makes sense for what is on screen, so changing the tab, place or search clears it.
  const pickTab = (k: Tab) => { setTab(k); setPicked({}) }
  const pickPlace = (id: string) => { setPlace(id); setPicked({}) }
  const search = (v: string) => { setQ(v); setPicked({}) }
  const click = (f: LibraryFile) => {
    if (!selecting) { setOpenId(f.id); return }
    setPicked(p => { const n = { ...p }; if (n[f.id]) delete n[f.id]; else n[f.id] = true; return n })
  }
  const download = () => showToast("Download isn't connected in this demo.", { icon: 'info', ms: 4000 })
  const remove = (gone: string[]) => {
    // A second delete while the first toast is still up joins it, so one Undo brings back both.
    const prev = lastDelete
    const earlier = prev && useUi.getState().toasts.some(t => t.key === FILE_DELETE && t.undo === prev.undo) ? prev.ids : []
    const ids = [...earlier, ...gone]
    agent.deleteFiles(gone)
    const undo = () => { agent.restoreFiles(ids); clearToast() }
    lastDelete = { ids, undo }
    showToast(`Deleted ${plural(ids.length)}`, { icon: 'delete', undo, key: FILE_DELETE })
  }

  // After a delete from a file's menu, focus goes to the next file, else the one before, else the list, else the
  // search box (the list is gone when the last file or search match was deleted), else the page.
  const focusAfter = useRef<string | null>(null)
  const list = useRef<HTMLDivElement | null>(null)
  // The files column: the selection bar centres on it.
  const filesArea = useRef<HTMLElement>(null)
  // Runs after every render, so a pending target is used (or dropped) by the first render after the delete.
  useEffect(() => {
    const to = focusAfter.current
    if (to === null) return
    focusAfter.current = null
    // After the menu's own close, which would give focus back to its (now gone) button.
    setTimeout(() => {
      const el = to ? document.querySelector<HTMLElement>(`[data-file-id="${CSS.escape(to)}"]`) : null
      const box = document.querySelector<HTMLElement>('main input[aria-label="Search library"]')
      ;(el ?? list.current ?? box ?? document.querySelector<HTMLElement>('main'))?.focus()
    }, 0)
  })
  const removeOne = (f: LibraryFile) => {
    const i = shown.indexOf(f)
    focusAfter.current = (shown[i + 1] ?? shown[i - 1])?.id ?? ''
    remove([f.id])
  }

  // Each file's menu. None in Select mode, where a click picks.
  const menuFor = (f: LibraryFile) => selecting ? null : (
    <FileMenu file={f} phone={phone} onOpen={() => setOpenId(f.id)} onDownload={download}
      onSource={f.link ? () => openSource(f) : undefined} onDelete={() => removeOne(f)} />
  )

  const panelItem = (id: string, name: string, icon: string, n: number) => {
    const active = place === id
    return phone ? (
      <button key={id} type="button" aria-pressed={active} onClick={() => pickPlace(id)}
        className={`${TAP_ROW} inline-flex h-8.5 flex-none items-center gap-1.75 rounded-full border py-0 pr-3.25 pl-2.75 text-sm font-strong whitespace-nowrap ${active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground-2'}`}>
        <Icon name={icon} size={16} />{name}<span className={cn('font-book tabular-nums', !active && 'text-muted-foreground')}>{n}</span>
      </button>
    ) : (
      // A place filters the files, so it's pressed, not the current page.
      <NavItem key={id} icon={icon} label={name} meta={n} active={active} aria-pressed={active} aria-current={undefined} onClick={() => pickPlace(id)} />
    )
  }

  return (
    // Desktop: the places panel and the title row stay put, and only the files scroll (App gives this page the height under the top bar). Phone: the page scrolls.
    <div className={phone ? 'flex flex-col gap-3 px-(--app-pad-x) pt-2 pb-24' : 'box-border flex min-h-0 grow basis-0 items-stretch gap-7 px-(--app-pad-x) pt-2'}>
      <aside aria-label="Places" className={phone ? 'flex min-w-0 flex-col gap-2.5' : 'flex w-library-nav flex-none flex-col gap-3.5 overflow-y-auto pb-6'}>
        <SearchBox value={q} onChange={search} placeholder="Search library" label="Search library" className="flex-none" />
        <nav aria-label="Library places" className={phone ? '-mx-(--app-pad-x) -my-1.5 flex gap-2 overflow-x-auto px-(--app-pad-x) py-1.5' : 'flex flex-col gap-px'}>
          {panelItem('all', 'All files', 'stacks', files.length)}
          {places.map(p => panelItem(p.id, p.name, p.icon, files.filter(f => f.place === p.id).length))}
        </nav>
      </aside>

      <section ref={filesArea} aria-label={title} className={phone ? 'min-w-0 flex-1' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
        <PageHeader title={title} truncate actions={<>
          <Select label="Sort" value={sort} options={SORTS} onChange={v => setSort(v as Sort)} minWidth={120} />
          <Segmented label="View" value={view} options={VIEWS} onChange={setView} className={cn(phone && '*:min-h-11')} />
          <Button variant="outline" size="lg" aria-pressed={selecting} onClick={() => (selecting ? endSelect() : setSelecting(true))}>
            {selecting ? 'Done' : 'Select'}
          </Button>
        </>} />
        <EdgeFade on={phone} className="mt-3.5 w-fit max-w-full self-start">
          {/* On desktop the tab bar is a nav row's 36px, level with the selected place beside it. */}
          <Segmented label="File type" value={tab} onChange={pickTab} className={cn(phone ? '*:min-h-11' : 'h-9')}
            options={TABS.map(([k, t]) => [k, <>{t} <span className="font-book text-muted-foreground tabular-nums">{count(k)}</span></>] as [Tab, ReactNode])} />
        </EdgeFade>

        <div className={phone ? undefined : '-mx-1 mt-3 min-h-0 flex-1 overflow-y-auto px-1 pb-24'}>
        {shown.length === 0 ? (
          <EmptyState variant="inline">
            {q.trim() ? `No files match "${q.trim()}".` : 'No files here yet.'}
          </EmptyState>
        ) : view === 'list' ? (
          <div ref={list} tabIndex={-1} role="list" aria-label="Files" className="mt-4 rounded-2xl border border-border bg-card px-2 py-1">
            {!phone && (
              <div className="flex items-center gap-1 border-b border-divider">
                <div className={`mono-label grid flex-1 ${LIST_COLS} gap-3.5 px-3 py-2.5`}>
                  <span>Name</span><span>Type</span><span>Place</span><span className="text-right">Size</span><span>Date</span>
                </div>
                {/* Room for each row's menu button. */}
                <span aria-hidden="true" className="size-8 flex-none" />
              </div>
            )}
            {shown.map(f => <Row key={f.id} file={f} phone={phone} selecting={selecting} on={!!picked[f.id]} onClick={() => click(f)} menu={menuFor(f)} />)}
          </div>
        ) : view === 'grid' ? (
          // On a phone two columns, whatever the width.
          <CardGrid ref={list} tabIndex={-1} role="list" aria-label="Files" size="sm" className={phone ? 'mt-4 grid-cols-2 gap-2.5' : 'mt-4'}>
            {shown.map(f => <Card key={f.id} file={f} grid selecting={selecting} on={!!picked[f.id]} onClick={() => click(f)} menu={menuFor(f)} />)}
          </CardGrid>
        ) : (
          <div ref={list} tabIndex={-1} role="list" aria-label="Files" className={`mt-4 ${phone ? 'columns-2 gap-2.5' : 'columns-library gap-3.5'}`}>
            {shown.map(f => <Card key={f.id} file={f} grid={false} selecting={selecting} on={!!picked[f.id]} onClick={() => click(f)} menu={menuFor(f)} />)}
          </div>
        )}
        </div>
      </section>

      {selecting && (
        <SelectionBar label="Selected files" status={pickedIds.length ? `${pickedIds.length} selected` : 'Select files'} over={filesArea}>
          {!phone && <Button variant="inverse" onClick={() => setPicked(Object.fromEntries(shown.map(f => [f.id, true as const])))}>Select all</Button>}
          <Button variant="inverse" disabled={!pickedIds.length} onClick={() => { download(); endSelect() }} className={cn(phone && TAP_ROW)}><Icon name="download" size={17} />Download</Button>
          <Button variant={pickedIds.length ? 'destructive' : 'inverse'} disabled={!pickedIds.length} onClick={() => setConfirm(true)} className={cn(phone && TAP_ROW)}><Icon name="delete" size={17} />Delete</Button>
        </SelectionBar>
      )}

      {open && <Viewer file={open} place={placeOf(open.place)} onClose={() => setOpenId(null)} onDownload={download}
        onPrev={prevId ? () => setOpenId(prevId) : undefined} onNext={nextId ? () => setOpenId(nextId) : undefined} />}
      {confirm && (
        <Confirm label="Delete files" title={`Delete ${plural(pickedIds.length)}?`} action="Delete" onCancel={() => setConfirm(false)}
          onConfirm={() => { remove(pickedIds); setConfirm(false); endSelect() }}>
          They leave the library for everyone on the team. You can undo it right after.
        </Confirm>
      )}
    </div>
  )
}

const LIST_COLS = 'grid-cols-library-list'

function Check({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className={`absolute top-2 right-2 box-border flex size-6 items-center justify-center rounded-full text-primary-foreground shadow-xs ${on ? 'border-2 border-card bg-primary' : 'border-hairline border-border-strong bg-card/90'}`}>
      {on && <Icon name="check" size={15} weight={500} />}
    </span>
  )
}

function Card({ file: f, grid, selecting, on, onClick, menu }: { file: LibraryFile; grid: boolean; selecting: boolean; on: boolean; onClick: () => void; menu: ReactNode }) {
  const place = useAgentData().library.places.find(p => p.id === f.place)
  const phone = useUi(s => s.phone)
  const frame = (child: React.ReactNode, bg = 'bg-muted') => (
    <div className={`relative overflow-hidden ${bg} ${grid ? 'aspect-4/3' : ''}`}>{child}</div>
  )
  // The picture part of the card. Plain files (no preview of their own) get a badge instead.
  let visual: React.ReactNode = null
  if (f.src) visual = frame(<img src={f.src} alt="" loading="lazy" className={`block w-full ${grid ? 'h-full' : ''} ${grid && f.ratio === '8/5' ? 'object-contain' : 'object-cover'}`} style={{ aspectRatio: grid ? undefined : f.ratio }} />)
  else if (f.doc) visual = frame(<DocPage doc={f.doc} />, 'bg-card')
  else if (f.media) visual = frame(<MediaFace file={f} ratio={grid ? '4 / 3' : '16 / 9'} />)
  else if (grid) {
    visual = frame(f.text
      ? <CodeBlock text={f.text} lines={9} className="box-border h-full rounded-none" />
      : <div className="absolute inset-0 flex items-center justify-center"><TypeBadge type={f.type} size={64} /></div>)
  }
  const head = !visual && (
    // On a phone the badge sits above the name, so the name gets the full card width for its two lines.
    <div className={`flex pt-3.5 pl-3.5 ${selecting ? 'pr-11' : 'pr-3.5'} ${phone ? 'flex-col items-start gap-2' : 'flex-row items-center gap-3'}`}>
      <TypeBadge type={f.type} size={40} />
      <span className="line-clamp-2 min-w-0 max-w-full flex-1 text-sm leading-card font-strong wrap-anywhere">{f.name}</span>
    </div>
  )
  return (
    // The card is the list item; the button inside opens (or, in Select mode, picks) the file, and the menu sits beside it.
    // The card draws the button's focus ring, since its rounded clip would cut the button's own.
    <div role="listitem"
      className={`group relative box-border w-full break-inside-avoid overflow-hidden rounded-xl border border-border bg-card transition has-[[data-file]:focus-visible]:outline-2 has-[[data-file]:focus-visible]:outline-offset-2 has-[[data-file]:focus-visible]:outline-ring ${grid ? 'm-0' : 'mx-0 mt-0 mb-3.5'} ${on ? 'shadow-selected' : 'shadow-card hover:-translate-y-px hover:shadow-float'}`}>
    <button type="button" data-file data-file-id={f.id} aria-pressed={selecting ? on : undefined} onClick={onClick} className="block h-full w-full text-left focus-visible:outline-none">
      {visual}
      {head}
      {!visual && f.text && !grid && <div className="px-3.5 pt-3"><CodeBlock text={f.text} lines={6} /></div>}
      <div className={cn(visual ? 'px-3 pt-2.5 pb-3' : 'px-3.5 pt-2 pb-3.25', menu && 'pr-12')}>
        {visual && (
          <div className="flex items-center gap-2">
            <span className={`line-clamp-2 min-w-0 flex-1 text-sm leading-card font-strong wrap-anywhere ${grid ? 'min-h-card-name' : ''}`}>{f.name}</span>
            {!f.src && <TypeChip type={f.type} />}
          </div>
        )}
        <div className={`flex items-center gap-1.25 text-xs text-muted-foreground ${visual ? 'mt-0.5' : ''}`}>
          {place && <Icon name={place.icon} size={13} />}<span className="ellipsis">{f.from}</span>
        </div>
      </div>
      {selecting && <Check on={on} />}
    </button>
    {menu && <div className="absolute right-2 bottom-2">{menu}</div>}
    </div>
  )
}

function Row({ file: f, phone, selecting, on, onClick, menu }: { file: LibraryFile; phone: boolean; selecting: boolean; on: boolean; onClick: () => void; menu: ReactNode }) {
  const thumb = f.src
    ? <img src={f.src} alt="" loading="lazy" className="block size-9 flex-none rounded-lg object-cover" />
    : <TypeBadge type={f.type} size={36} />
  return (
    <div role="listitem" className={`group flex items-center gap-1 rounded-lg transition ${on ? 'bg-fill' : 'hover:bg-accent'}`}>
    <button type="button" data-file-id={f.id} aria-pressed={selecting ? on : undefined} onClick={onClick}
      className={`box-border min-h-13.5 min-w-0 flex-1 items-center gap-3.5 rounded-lg px-3 py-2 text-left text-sm ${phone ? 'flex' : `grid ${LIST_COLS}`}`}>
      <span className={`flex min-w-0 items-center gap-3 ${phone ? 'flex-1' : ''}`}>
        {selecting && <span aria-hidden="true" className={`box-border flex size-5 flex-none items-center justify-center rounded-full text-primary-foreground ${on ? 'bg-primary' : 'border-hairline border-border-strong bg-card'}`}>{on && <Icon name="check" size={14} weight={500} />}</span>}
        {thumb}
        <span className="min-w-0">
          <span className="ellipsis block text-base font-strong">{f.name}</span>
          {phone && <span className="ellipsis block text-xs text-muted-foreground">{f.type} · {f.size} · {f.from}</span>}
        </span>
      </span>
      {!phone && <><span className="font-mono text-xs text-foreground-3">{f.type}</span><span className="ellipsis text-foreground-3">{f.from}</span><span className="text-right text-foreground-3 tabular-nums">{f.size}</span><span className="text-foreground-3 tabular-nums">{f.date}</span></>}
    </button>
    {menu ?? (!phone && <span aria-hidden="true" className="size-8 flex-none" />)}
    </div>
  )
}

/** A file's "···" menu: Open, Download, where it came from and Delete. Shown on hover and focus, always on a phone. */
function FileMenu({ file, phone, onOpen, onDownload, onSource, onDelete }: {
  file: LibraryFile; phone: boolean; onOpen: () => void; onDownload: () => void; onSource?: () => void; onDelete: () => void
}) {
  const items: [string, string, () => void][] = [
    ['open_in_full', 'Open', onOpen],
    ['download', 'Download', onDownload],
    ...(onSource && file.link ? [[file.link.to === 'chat' ? 'chat_bubble' : file.link.to === 'routines' ? 'event_repeat' : 'task_alt', OPEN[file.link.to], onSource] as [string, string, () => void]] : []),
  ]
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more_horiz" label={`Actions for ${file.name}`} size={18}
          className={cn('bg-card shadow-xs hover:bg-accent data-[state=open]:opacity-100', phone ? TAP : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={16} aria-label="File actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input">
        {items.map(([icon, t, go]) => (
          <MenuItem key={t} onSelect={go}>
            <Icon name={icon} size={18} />{t}
          </MenuItem>
        ))}
        <DropdownMenuSeparator className="mx-0 my-1" />
        <MenuItem variant="destructive" onSelect={onDelete}>
          <Icon name="delete" size={18} />Delete
        </MenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Phone: a row that scrolls sideways inside itself, with a fade at the right edge while more is hidden there. */
function EdgeFade({ on, className, children }: { on: boolean; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    // The scrolling element is the control inside (a segmented control scrolls itself).
    const el = box.current?.firstElementChild
    if (!on || !(el instanceof HTMLElement)) { setMore(false); return }
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    check()
    el.addEventListener('scroll', check, { passive: true })
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', check); ro.disconnect() }
  }, [on])
  return (
    <div ref={box} className={cn('relative', className)}>
      {children}
      {more && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-lg bg-linear-to-l from-background" />}
    </div>
  )
}
