// See all: every chat, pinned first, then newest first grouped by day, with a search box that filters by title,
// a "···" menu on each row and Select for deleting several at once (the toast has Undo).
import { useEffect, useRef, useState } from 'react'
import { chatEntries, useCtx, useUi } from '../../state/store'
import { Button, EmptyState, Icon, Page, PageHeader, SectionHeader, SelectionBar } from '../../ui'
import { ChatRow, SuggestionChip } from '../../ui/chat'
import { SearchBox } from '../../ui/fields'

export function ChatList() {
  const { data, agent: agentState } = useCtx()
  const openChat = useUi(s => s.openChat)
  const newChat = useUi(s => s.newChat)
  const ask = useUi(s => s.ask)
  const deleteChats = useUi(s => s.deleteChats)
  const started = useUi(s => s.started)
  const phone = useUi(s => s.phone)
  // Every chat that is answering shows its dot, open or not (decision D9).
  const runs = useUi(s => s.runs)
  const [q, setQ] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Record<string, true>>({})
  // The list the selection bar acts on: the bar centres on it.
  const content = useRef<HTMLDivElement>(null)
  const needle = q.trim().toLowerCase()
  const found = chatEntries(data, started, agentState).filter(c => c.title.toLowerCase().includes(needle))
  const pinned = found.filter(c => c.pinned)
  const rest = found.filter(c => !c.pinned)
  const groups: [string, typeof found][] = [
    ...(pinned.length ? [['Pinned', pinned] as [string, typeof found]] : []),
    ...[...new Set(rest.map(c => c.day))].map(day => [day, rest.filter(c => c.day === day)] as [string, typeof found]),
  ]
  const pickedIds = found.filter(c => picked[c.id]).map(c => c.id)

  const endSelect = () => { setSelecting(false); setPicked({}) }
  // A pick only makes sense for what is on screen, so a new search clears it.
  const search = (v: string) => { setQ(v); setPicked({}) }
  const toggle = (id: string) => setPicked(p => { const n = { ...p }; if (n[id]) delete n[id]; else n[id] = true; return n })
  const remove = () => {
    deleteChats(pickedIds); endSelect()
    // The toolbar that had focus is gone: land on the first row left, else the list's fallback.
    requestAnimationFrame(() => {
      const main = document.querySelector('main')
      ;(main?.querySelector<HTMLElement>('[data-chat-row] [data-chat-open]') ?? main?.querySelector<HTMLElement>('[data-chat-fallback]'))?.focus()
    })
  }

  // Escape leaves Select mode, as in the Library.
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSelecting(false); setPicked({}) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  return (
    // The same Page column as every list page. Chats lays its screen out in a flex column, so the column takes the
    // full width (else it shrinks to its content). In Select mode the last row scrolls clear of the bar.
    <Page className="w-full pt-2">
      <div ref={content}>
        <PageHeader title="All chats" className="mb-3.5" />
        <div className="flex items-center gap-2.5">
          <SearchBox value={q} onChange={search} placeholder="Search chats" label="Search chats" />
          <Button variant="outline" size="lg" aria-pressed={selecting} disabled={!selecting && found.length === 0} onClick={() => (selecting ? endSelect() : setSelecting(true))} className="flex-none">
            {selecting ? 'Done' : 'Select'}
          </Button>
          <Button variant="outline" size="lg" onClick={() => newChat()} className="flex-none gap-2">
            <Icon name="add" size={18} />New chat
          </Button>
        </div>
        {groups.map(([day, rows]) => (
          <section key={day} aria-label={day}>
            <SectionHeader title={day} className="mt-6 mb-2.5" />
            {/* A 2px gap, so two picked (or hovered) rows next to each other stay two rows. */}
            <div className="flex flex-col gap-0.5 rounded-2xl border border-border bg-card px-2 py-1">
              {rows.map(c => (
                <ChatRow key={c.id} chat={c} place="list" running={!!runs[c.id]} picked={selecting ? !!picked[c.id] : undefined}
                  onClick={() => (selecting ? toggle(c.id) : openChat(c.id))} />
              ))}
            </div>
          </section>
        ))}
        {/* What shows with no chats (M19): a search that found none, with Clear, or none at all, with questions to start one. */}
        {found.length === 0 && (
          <div tabIndex={-1} data-chat-fallback className="flex flex-col items-center outline-none">
            {needle ? (
              <>
                <EmptyState variant="inline" className="mb-3">No chats match "{q.trim()}".</EmptyState>
                <Button variant="outline" onClick={() => search('')}>Clear search</Button>
              </>
            ) : (
              <EmptyState className="mt-6 flex w-full flex-col items-center gap-3 py-8">
                <Icon name="forum" size={28} className="text-muted-foreground" />
                <span className="text-md font-medium text-foreground">No chats yet</span>
                {data.chat.suggestions.length > 0 && (
                  <span className="mt-1 flex flex-wrap justify-center gap-2">
                    {data.chat.suggestions.map(t => <SuggestionChip key={t} question={t} onAsk={x => { void ask(x) }} />)}
                  </span>
                )}
              </EmptyState>
            )}
          </div>
        )}
        {/* Select mode: the last row scrolls clear of the bar, above a phone's home bar too. */}
        {selecting && <div aria-hidden="true" className="h-selection-room" />}
      </div>

      {selecting && (
        <SelectionBar label="Selected chats" status={pickedIds.length ? `${pickedIds.length} selected` : 'Select chats'} over={content}>
          {!phone && <Button variant="inverse" onClick={() => setPicked(Object.fromEntries(found.map(c => [c.id, true as const])))}>Select all</Button>}
          <Button variant={pickedIds.length ? 'destructive' : 'inverse'} disabled={!pickedIds.length} onClick={remove}>
            <Icon name="delete" size={17} />Delete
          </Button>
        </SelectionBar>
      )}
    </Page>
  )
}
