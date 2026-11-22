// Chats: the thread (one card per answer, D2), hover actions under each answer and your own messages, the "···" menu,
// long messages that fold, Retry on a stopped answer, Jump to latest, the queued messages and the ask box.
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { agent } from '../agent'
import { traceOf, useTraces } from './chat/traces'
import { CONNECTION_TEXT, NOTICE_TEXT, historyWanted } from './chat/notes'
import type { ChatMessage } from '../agent/types'
import { Composer, PHONE_QUERY } from '../components/Composer'
import { fileIcon, fileSize } from '@/lib/file-meta'
import { listNames, readingTools, toolDetail } from '../state/derive'
import { cn } from '@/lib/utils'
import { isStoppedNote, openChatKey, openRun, useCtx, useUi } from '../state/store'
import type { QueuedMsg } from '../state/store'
import { Confirm, TAP } from '../ui/fields'
import { AgentMark, AttachmentChip, Button, Icon, IconButton, LogoTile, MenuItem, StageTag } from '../ui'
import { PromptBentoSlot } from '../ui/chat'
import { Button as UiButton } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentPart, ApprovalCard } from './chat/Parts'
import { SourcesRow, StepsLine } from './chat/Steps'
import { toolInText } from './chat/step-data'
import { useOpenChatMessages } from './chat/open-messages'
import { FileChip } from './chat/FileChip'
import { filesOfTurns } from './chat/view'
import { ChatList } from './chat/ChatList'
import { copyText } from './chat/copy'

/** Within this many px of the bottom, new messages and thinking steps keep the view at the bottom. */
const NEAR_BOTTOM = 80
/** Shown on hover and focus, always on a phone or a touch screen. */
const REVEAL = 'opacity-0 transition-opacity duration-120 group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 pointer-coarse:opacity-100 data-[on=1]:opacity-100'

/** A phone menu's thumbs: a radio item that looks like the menu's other rows (MenuItem), its own check at the right. */
const RATE_ITEM = 'h-9.5 pl-2.5 text-base text-foreground [&>span:first-child]:hidden'

/** Thumbs up or down on an answer: a pressed toggle, filled while on. */
function Rate({ icon, label, on, onClick }: { icon: string; label: string; on: boolean; onClick: () => void }) {
  return (
    <IconButton icon={icon} label={label} size={17} variant="action" box="icon-sm" filled={on} aria-pressed={on} onClick={onClick} className={cn(on && 'text-foreground hover:text-foreground')} />
  )
}

export function Chats() {
  const chatList = useUi(s => s.chatList)
  return chatList ? <ChatList /> : <Thread />
}

type UserMsg = Extract<ChatMessage, { role: 'user' }>
type AgentMsg = Extract<ChatMessage, { role: 'agent' }>
/** The thread as it shows: a question, a note, or an answer turn (every agent message in a row, in one card, D2). */
type Block = { kind: 'user'; m: UserMsg; at: number } | { kind: 'event'; m: Extract<ChatMessage, { role: 'event' }>; at: number } | { kind: 'turn'; ms: AgentMsg[]; at: number }

function blocksOf(msgs: ChatMessage[]): Block[] {
  const out: Block[] = []
  msgs.forEach((m, at) => {
    const prev = out[out.length - 1]
    if (m.role === 'agent') { if (prev?.kind === 'turn') prev.ms.push(m); else out.push({ kind: 'turn', ms: [m], at }) }
    else if (m.role === 'user') out.push({ kind: 'user', m, at })
    else out.push({ kind: 'event', m, at })
  })
  return out
}

/** A long message shows about eight lines, with Show more (M8). Expanding keeps the reader's place. */
function LongText({ text, onToggle }: { text: string; onToggle: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || open) return
    const check = () => setLong(el.scrollHeight > el.clientHeight + 1)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [open, text])
  return (
    <>
      <div ref={ref} id={id} data-long-text className={cn(!open && 'line-clamp-8')}>{text}</div>
      {(long || open) && (
        // Its visible words are its name (label in name); aria-expanded carries the state.
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => { onToggle(); setOpen(o => !o) }}
          className="-ml-1 mt-1.5 flex h-7 items-center gap-0.5 rounded-md pr-1.5 pl-1 text-sm font-medium text-foreground-3 hover:bg-fill-strong hover:text-foreground">
          {open ? 'Show less' : 'Show more'}<Icon name={open ? 'expand_less' : 'expand_more'} size={17} />
        </button>
      )}
    </>
  )
}

/** A message's first words, to tell its buttons apart from the next message's. */
const firstWords = (text: string): string => {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length <= 40 ? t : t.slice(0, 40).replace(/\s+\S*$/, '') + '…'
}

/** A message typed while the answer streams: it waits above the composer. Send now stops the answer and sends it (H8).
 *  After Stop it waits paused: only Send now sends it (D). Edit waits while another message is being edited (F). */
function QueuedChip({ q, editing, onEdit, onSendNow, onRemove }: { q: QueuedMsg; editing: boolean; onEdit: (q: QueuedMsg) => void; onSendNow: (q: QueuedMsg) => void; onRemove: (q: QueuedMsg) => void }) {
  const phone = useUi(s => s.phone)
  const words = firstWords(q.text)
  return (
    <div data-queued data-paused={q.paused || undefined} className="flex min-w-0 items-center gap-1.5 rounded-2xl border border-border bg-card py-1.5 pr-1.5 pl-3 text-sm shadow-float">
      <Icon name={q.paused ? 'pause' : 'schedule_send'} size={16} className="flex-none text-muted-foreground" />
      <span className="flex-none text-muted-foreground">{q.paused ? 'Paused' : 'Queued'}</span>
      <span className="ellipsis min-w-0 flex-1 text-foreground-2">{q.text}</span>
      <IconButton icon="edit" label={`Edit queued message: ${words}`} tip="Edit" size={17} box="icon-sm" disabled={editing} onClick={() => onEdit(q)} className={cn('flex-none', phone && TAP)} />
      <Button data-queued-send variant="soft" size="sm" aria-label={`Send now: ${words}`} onClick={() => onSendNow(q)} className={cn('flex-none', phone && TAP)}>Send now</Button>
      <IconButton data-queued-remove icon="close" label={`Remove queued message: ${words}`} tip="Remove" size={17} box="icon-sm" onClick={() => onRemove(q)} className={cn('flex-none', phone && TAP)} />
    </div>
  )
}

const NO_QUEUE: QueuedMsg[] = []
/** An answer turn's card (D2). */
const CARD = 'box-border flex max-w-full min-w-0 flex-col gap-3.5 self-start rounded-3xl bg-card py-4'

/**
 * The working line while an answer streams, always one line: the agent's mark (moving, whatever the demo's switch says),
 * the logo of the tool the step names, and the step's text with a light sweep across it. New text fades up. Hidden from the
 * log: the status line reads it out.
 */
function Thinking({ text }: { text: string }) {
  const ctx = useCtx()
  // The logo only of a tool the agent can read now, the one the text names first.
  const tool = toolInText(ctx.data, text, readingTools(ctx))
  return (
    <div data-thinking aria-hidden="true" className="flex min-w-0 items-center gap-2.5">
      <AgentMark live />
      {tool !== null && <LogoTile k={tool} size="sm" round />}
      <span key={text} className="min-w-0 animate-step-in"><span className="shimmer-text ellipsis block text-base">{text}</span></span>
    </div>
  )
}

function Thread() {
  useTraces()
  const ctx = useCtx()
  const { fresh, chatId, phone, feedback } = useUi()
  const run = useUi(openRun)
  const thinking = !!run
  const view = useUi(s => { const k = openChatKey(s, agent.read()); return k !== null && Object.hasOwn(s.views, k) ? s.views[k] : undefined })
  const link = useSyncExternalStore(agent.onLink, agent.link)
  const thinkingText = view?.budgetWait ? NOTICE_TEXT.budget_busy : run?.text ?? ''
  const editingId = useUi(s => s.editMsg?.id)
  const { ask, patch, showToast, openTeam, regenerate, rateAnswer, go, deleteMessages, startEdit, unqueue, sendQueuedNow } = useUi.getState()
  const [menuId, setMenuId] = useState<string | null>(null)
  // Edit of a queued message over a draft asks first.
  const [replacing, setReplacing] = useState<QueuedMsg | null>(null)
  // Replace puts focus in the composer; closing the question must not take it back to the Edit button.
  const replaced = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  // Null for a new chat, and when there are no chats at all (day one): the thread then starts empty.
  const openId = openChatKey({ fresh, chatId }, ctx.data)
  const localQueue = useUi(s => (openId === null ? NO_QUEUE : s.queued[openId] ?? NO_QUEUE))
  // What the agent holds waiting in the run, then what waits paused here (after a reload).
  const sentQueue = run?.sent
  const queue = useMemo(() => (sentQueue?.length ? [...sentQueue, ...localQueue] : localQueue), [sentQueue, localQueue])
  // After Send now or Remove, focus goes to the chip that takes that one's place (the same button), else to the field;
  // on a phone to Send instead (the field would pop the keyboard), or to "+" while Send is off or Stop holds its place
  // (a tap or Enter there would stop the answer just asked).
  const queueList = useRef<HTMLDivElement>(null)
  const focusAfter = useRef<{ at: number; button: 'send' | 'remove' } | null>(null)
  useLayoutEffect(() => {
    const f = focusAfter.current
    if (!f) return
    focusAfter.current = null
    const chips = queueList.current?.querySelectorAll<HTMLElement>('[data-queued]') ?? []
    const chip = chips.length ? chips[Math.min(f.at, chips.length - 1)] : undefined
    const send = document.querySelector<HTMLButtonElement>('[data-composer] [data-composer-send][aria-label="Send"]')
    const away = !window.matchMedia(PHONE_QUERY).matches ? document.querySelector<HTMLElement>('[data-composer] textarea')
      : send && !send.disabled ? send : document.querySelector<HTMLElement>('[data-composer] button[aria-label^="Attach"]')
    const target = chip?.querySelector<HTMLElement>(`[data-queued-${f.button}]`) ?? away
    target?.focus()
  }, [queue])
  const chipAction = (q: QueuedMsg, button: 'send' | 'remove') => {
    focusAfter.current = { at: queue.indexOf(q), button }
    if (button === 'send') sendQueuedNow(q.id); else unqueue(q.id)
    // Nothing changed (it had already gone): no focus move waits for a later change.
    if (openId === null || (useUi.getState().queued[openId] ?? NO_QUEUE) === localQueue && (openRun(useUi.getState())?.sent ?? NO_QUEUE) === (run?.sent ?? NO_QUEUE)) focusAfter.current = null
  }
  const queueStatus = queue.length === 0 ? '' : `${queue.length} ${queue.length === 1 ? 'message' : 'messages'} ${queue.every(q => q.paused) ? 'paused' : 'queued'}`
  const history = useUi(s => (openId === null ? undefined : s.history[openId]))
  const noSeed = historyWanted(ctx.data.chat.chats, openId)
  const loadHistory = useUi(s => s.loadHistory)
  // A chat the agent keeps (no sample turns) reads its past when it opens.
  useEffect(() => { if (openId !== null && noSeed) loadHistory(openId) }, [openId, noSeed, loadHistory])
  const msgs = useOpenChatMessages()

  // The turns this view saw running, in this chat: only their text is revealed word by word (what's already there when a chat
  // opens, a reload or a reopened chat is not), and a reveal that began runs on after the run ends. A turn counts only when it
  // is first seen after the chat's history is in (or the chat was started here): on a reload the replayed run shows up while
  // the history is still loading, and that turn never counts (`skip`). Adjusted during render (React redraws at once), so a
  // turn is in before its first part draws.
  const startedHere = useUi(s => openId !== null && s.started.some(c => c.id === openId))
  const historyIn = !noSeed || startedHere || history?.state === 'ready'
  const [seen, setSeen] = useState<{ key: string | null; ids: ReadonlySet<string>; skip: ReadonlySet<string> }>({ key: openId, ids: new Set(), skip: new Set() })
  let seenNow = seen.key === openId ? seen : { key: openId, ids: new Set<string>(), skip: new Set<string>() }
  // This tab's own run (a send from here) always counts; a turn only the stream reports (`view.live`, a replay) counts once
  // the history is in.
  for (const [t, counts] of [[run?.turnId, true], [view?.live, historyIn]] as const) {
    if (!t || seenNow.ids.has(t) || seenNow.skip.has(t)) continue
    seenNow = counts ? { ...seenNow, ids: new Set([...seenNow.ids, t]) } : { ...seenNow, skip: new Set([...seenNow.skip, t]) }
  }
  if (seenNow !== seen) setSeen(seenNow)
  // Answers with words still to come: the log is busy while there are any, so a screen reader doesn't read half an answer.
  const [revealing, setRevealing] = useState<ReadonlySet<string>>(() => new Set())
  const onBusy = useCallback((id: string, busy: boolean) => setRevealing(cur => {
    if (cur.has(id) === busy) return cur
    const next = new Set(cur)
    if (busy) next.add(id); else next.delete(id)
    return next
  }), [])

  // Keep the view at the bottom as messages and thinking steps arrive, but only while the person is near it:
  // once they scroll up, their place stays and Jump to latest shows. Asking a question goes back to the bottom.
  const threadKey = openId ?? 'new'
  const stick = useRef(true)
  // This visit to the chat (a new one each time it opens, so X, Y, then X again starts at the bottom) and the visit the
  // person scrolled up in: opening a chat starts without Jump to latest.
  const visit = useMemo(() => ({ key: threadKey }), [threadKey])
  const [awayIn, setAwayIn] = useState<object | null>(null)
  const away = awayIn === visit
  // The newest question seen, so a new one (an ask, or a regenerate that also hides older messages) goes to the bottom.
  const seenQuestion = useRef<string | undefined>(undefined)
  // The scroll event for our own scroll arrives a frame later, when content may have grown again: it isn't the person
  // scrolling up. Only that one event is skipped.
  const pinnedTop = useRef(-1)
  const scrollDown = () => {
    const el = scroller.current
    if (el) {
      const before = el.scrollTop
      el.scrollTop = el.scrollHeight
      // Only a scroll that moved the view sends an event to skip.
      if (el.scrollTop !== before) pinnedTop.current = el.scrollTop
    }
    stick.current = true
  }
  const toBottom = () => { scrollDown(); setAwayIn(null) }
  /** Whether the view is near the bottom now, and Jump to latest with it. */
  const recheck = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
    setAwayIn(stick.current ? null : visit)
  }
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    if (el.scrollTop === pinnedTop.current) { pinnedTop.current = -1; return }
    recheck()
  }
  // Show more or less, and opening an answer's steps or sources, keeps the reader where they are: it grows below, the view doesn't follow it down.
  const onToggleLong = () => { stick.current = false; requestAnimationFrame(recheck) }
  const last = msgs[msgs.length - 1]
  const lastQuestion = last?.role === 'user' ? last.id : undefined
  useLayoutEffect(() => { scrollDown() }, [threadKey])
  // Content keeps settling after first paint (fonts, markdown, cards), and the composer grows or shrinks the scroll
  // area: while at the bottom, stay there.
  useEffect(() => {
    const col = column.current, sc = scroller.current
    if (!col || !sc || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { if (stick.current) scrollDown() })
    ro.observe(col)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (lastQuestion && lastQuestion !== seenQuestion.current) { stick.current = true; setAwayIn(null) }
    seenQuestion.current = lastQuestion ?? seenQuestion.current
    if (stick.current) scrollDown()
  }, [msgs.length, lastQuestion, thinking, thinkingText])

  // The tools the agent can read now: not paused, not disconnected, none on day one.
  const connected = readingTools(ctx).map(k => toolDetail(ctx.data, k).name)

  const copy = (text: string) => copyText(text)
  /** What follows a question up to the next one: its answer and a stopped note, hidden with it when it's asked again. */
  const answerOf = (at: number) => {
    const ids: string[] = []
    for (let j = at + 1; j < msgs.length && msgs[j].role !== 'user'; j++) ids.push(msgs[j].id)
    return ids
  }
  /** The question an answer or a stopped note belongs to, and what lies between. */
  const questionBefore = (at: number): { q: UserMsg; between: string[] } | null => {
    const between: string[] = []
    for (let j = at - 1; j >= 0; j--) {
      const m = msgs[j]
      if (m.role === 'user') return { q: m, between: between.reverse() }
      between.push(m.id)
    }
    return null
  }
  /** A queued message back in the composer, to change and send. */
  const putBack = (q: QueuedMsg) => {
    if (!unqueue(q.id)) return
    patch({ replyTo: q.quote ?? null, atts: q.atts ?? [] })
    useUi.getState().setComposerText(q.text, { focus: true })
  }
  // A draft, files or a quote in the composer would be lost: ask first.
  const editQueued = (q: QueuedMsg) => {
    const s = useUi.getState()
    replaced.current = false
    if (s.chatDraft.trim() || s.atts.length || s.replyTo) setReplacing(q); else putBack(q)
  }
  const bubbleMax = phone ? 'max-w-22/25' : 'max-w-18/25'
  const blocks = blocksOf(msgs)

  /** Under an answer: the actions; on a phone Copy and "···" (D3). */
  const answerBar = (b: Extract<Block, { kind: 'turn' }>) => {
    const m = b.ms[b.ms.length - 1]
    const i = b.at + b.ms.length - 1
    const next = msgs[i + 1]
    const menuOpen = menuId === m.id
    // An error turn has no answer to act on (its steps line sits above its card).
    if (m.part.type === 'error') return null
    const txt = b.ms.flatMap(x => (x.part.type === 'text' ? [x.part.text] : [])).join('\n\n') || "Inhouse agent's answer"
    const ask0 = questionBefore(b.at)
    const question = ask0?.q
    // Thumbs belong to the turn, keyed by its first answer message: it doesn't change while the turn streams.
    const turnId = b.ms[0].id
    // A stopped turn's note goes with it when it is asked again.
    const tail = next?.role === 'event' ? [next.id] : []
    const turnIds = b.ms.map(x => x.id)
    const again = question && (() => regenerate([question.id, ...(ask0?.between ?? []), ...turnIds, ...tail], { text: question.text, quote: question.quote, atts: question.atts }))
    const S = ctx.S
    const sendChannel = ctx.data.tools.channels[0]
    const items: { icon: string; t: string; go: () => void; destructive?: boolean; sep?: boolean; locked?: boolean; disabled?: boolean }[] = [
      // A phone's row keeps Copy, the steps and "···": the rest of the row moves into the menu (D3), the thumbs as a
      // radio pair after these.
      ...(phone ? [
        { icon: 'reply', t: 'Reply', go: () => patch({ replyTo: txt.slice(0, 140) }) },
        ...(again ? [{ icon: 'refresh', t: 'Regenerate', go: again, disabled: thinking }] : []),
      ] : []),
      ...(sendChannel ? [{ icon: 'tag', t: `Send to ${sendChannel.name}`, sep: phone, go: () => { if (S >= sendChannel.need) showToast(`Send to ${sendChannel.name} isn't connected in this demo.`, { icon: 'info', ms: 4000 }) }, locked: S < sendChannel.need }] : []),
      { icon: 'flag', t: 'Report a wrong answer', sep: phone && !sendChannel, go: () => openTeam('bug', 'This answer looks wrong: "' + txt.slice(0, 120) + '"') },
      // Undo works from any chat: the store finds this chat wherever it is by then (M5).
      { icon: 'delete', t: 'Delete', destructive: true, sep: true, go: () => { if (openId !== null) deleteMessages(openId, [...turnIds, ...tail]) } },
    ]
    const more = (
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={o => setMenuId(o ? m.id : null)}>
        <DropdownMenuTrigger asChild>
          <IconButton icon="more_horiz" label="More" size={18} variant="action" box="icon-sm" className="flex-none" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" alignOffset={-4} collisionPadding={16} aria-label="Message actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input"
          // A window opened by an item ("Report a wrong answer") takes focus itself.
          onCloseAutoFocus={e => { if (useUi.getState().pop === 'team') e.preventDefault() }}>
          {items.map((it, j) => (
            <Fragment key={it.t}>
              {it.sep && <DropdownMenuSeparator className="mx-0 my-1" />}
              <MenuItem variant={it.destructive ? 'destructive' : 'default'} locked={it.locked} disabled={it.disabled} onSelect={it.go}>
                <Icon name={it.icon} size={18} />
                <span className="flex-1">{it.t}</span>
                {it.locked && <StageTag tag="Act" icon={false} />}
              </MenuItem>
              {/* A phone's thumbs: one pick or none, announced as checked. Picking the one that's on takes it back. */}
              {phone && j === (again ? 1 : 0) && (
                <DropdownMenuRadioGroup aria-label="Rate this answer" value={feedback[turnId] ?? ''}>
                  {([['up', 'thumb_up', 'Good answer'], ['down', 'thumb_down', 'Bad answer']] as const).map(([v, icon, t]) => (
                    <DropdownMenuRadioItem key={v} value={v} onSelect={() => rateAnswer(turnId, v, txt)} className={RATE_ITEM}>
                      <Icon name={icon} size={18} fill={feedback[turnId] === v} />
                      <span className="flex-1">{t}</span>
                      {feedback[turnId] === v && <Icon name="check" size={18} />}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              )}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
    const copyBtn = <IconButton icon="content_copy" label="Copy message" size={17} variant="action" box="icon-sm" className="flex-none" onClick={() => copy(txt)} />
    if (phone) {
      return (
        <div data-on="1" className="relative mt-1.5 flex max-w-full items-center gap-0.5 self-start rounded-md pl-1 text-sm text-foreground-3">
          {copyBtn}
          <span className="flex flex-none">{more}</span>
        </div>
      )
    }
    // The actions show on hover or focus, and stay while More is open so the menu's button never fades from under the pointer.
    const on = menuOpen ? '1' : undefined
    return (
      <div data-on={on} className="relative mt-1.5 flex flex-wrap items-center gap-0.5 self-start rounded-md pl-1 text-sm text-foreground-3">
        <span data-on={on} data-answer-actions className={cn('flex flex-wrap items-center gap-0.5', REVEAL)}>
          <IconButton icon="reply" label="Reply" size={17} variant="action" box="icon-sm" onClick={() => patch({ replyTo: txt.slice(0, 140) })} />
          {copyBtn}
          {again && <IconButton icon="refresh" label="Regenerate" size={17} variant="action" box="icon-sm" disabled={thinking} onClick={again} />}
          <Rate icon="thumb_up" label="Good answer" on={feedback[turnId] === 'up'} onClick={() => rateAnswer(turnId, 'up', txt)} />
          <Rate icon="thumb_down" label="Bad answer" on={feedback[turnId] === 'down'} onClick={() => rateAnswer(turnId, 'down', txt)} />
          {more}
        </span>
      </div>
    )
  }

  const isBlank = msgs.length === 0 && !thinking && queue.length === 0 && historyIn
  const notices = (ctx.agent.paused !== null || view?.notice || view?.damaged || link !== 'live') ? (
    <div data-chat-notice role="status" className="mb-2 flex flex-col gap-1.5">
      {link !== 'live' && (
        <div className="flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm text-foreground-3">
          <Icon name={link === 'held' ? 'refresh' : 'info'} size={16} className="flex-none" />
          <span className="min-w-0 flex-1">{CONNECTION_TEXT[link]}</span>
          {(link === 'reload' || link === 'grantEnded') && <Button variant="soft" size="sm" onClick={() => location.reload()}>Reload</Button>}
        </div>
      )}
      {ctx.agent.paused !== null && (
        <div className="flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm text-foreground-3"><Icon name="pause" size={16} className="flex-none" /><span className="min-w-0 flex-1">{NOTICE_TEXT.paused}</span></div>
      )}
      {view?.notice && !view.damaged && view.notice.code !== 'paused' && !view.budgetWait && (
        <div className="flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm text-foreground-3"><Icon name="info" size={16} className="flex-none" /><span className="min-w-0 flex-1">{view.notice.text}</span></div>
      )}
      {view?.damaged && openId !== null && (
        <div className="flex items-center gap-2 rounded-xl bg-accent px-3 py-2 text-sm text-foreground-3">
          <Icon name="error" size={16} className="flex-none" />
          <span className="min-w-0 flex-1">{NOTICE_TEXT.session_damaged}</span>
          <Button variant="soft" size="sm" onClick={() => useUi.getState().resetSession(openId)}>Start fresh</Button>
        </div>
      )}
    </div>
  ) : null

  return (
    <div className={cn('relative flex min-h-0 flex-1 flex-col', isBlank && 'overflow-auto')}>
      <div ref={scroller} onScroll={onScroll} className={isBlank ? 'flex grow shrink-0 flex-col justify-end px-(--app-pad-x) pt-8' : 'flex-1 overflow-auto px-(--app-pad-x) pt-2 pb-14'}>
        <div ref={column} className={cn('mx-auto flex w-full flex-col', isBlank ? 'max-w-today-column items-center text-center' : 'max-w-chat-column')}>
          {isBlank ? (
            <>
              <h2 className="text-3xl leading-title font-medium tracking-title">What do you want to know?</h2>
              {connected.length > 0
                ? <p className="mt-2.5 text-md text-foreground-3">Your Inhouse agent reads {listNames(connected)}.</p>
                : <>
                    <p className="mt-2.5 text-md text-foreground-3">No tools are connected yet.</p>
                    <Button variant="outline" className="mt-3" onClick={() => go('apps')}>Connect tools</Button>
                  </>}
            </>
          ) : (
            <>
              {/* The conversation as a log, so screen readers hear each new answer once (not every thinking step).
                  Keyed by chat, so opening a chat doesn't read out its whole history. */}
              {history && (history.next !== null || history.state === 'error') && (
                <div className="mt-2 flex justify-center">
                  <Button variant="soft" size="sm" disabled={history.state === 'loading'} onClick={() => loadHistory(openId!, history.state !== 'error' || history.next !== null)}>
                    {history.state === 'error' ? "Couldn't load earlier messages. Try again" : 'Show earlier messages'}
                  </Button>
                </div>
              )}
              <div key={threadKey} role="log" aria-label="Conversation" aria-busy={revealing.size > 0 || undefined} className="flex flex-col">
              {blocks.map((b, k) => {
                const mt = k === 0 ? 'mt-2' : b.kind === 'event' ? 'mt-3.5' : 'mt-5.5'
                if (b.kind === 'user') {
                  const m = b.m
                  return (
                    <div key={m.id} data-chat-msg className={`group/msg relative flex flex-col ${mt}`}>
                      {/* Desktop: the actions sit beside the bubble, out of the flow, so they cost no space at rest.
                          Phone and touch: in the flow under the bubble, always visible. */}
                      <div className={`relative flex flex-col items-end self-end ${bubbleMax}`}>
                        <div className={cn('max-w-prose-measure rounded-3xl bg-bubble px-4.5 py-3 text-md leading-prose text-pretty whitespace-pre-wrap wrap-anywhere', editingId === m.id && 'shadow-selected')}>
                          {m.quote && (
                            <div className="mb-2 flex gap-2 overflow-hidden rounded-lg bg-fill px-2.5 py-1.5 text-sm whitespace-nowrap text-foreground-3">
                              <Icon name="reply" size={15} />
                              <span className="overflow-hidden text-ellipsis">{m.quote}</span>
                            </div>
                          )}
                          <LongText text={m.text} onToggle={onToggleLong} />
                        </div>
                        <div data-on={phone ? '1' : undefined} className={cn(phone ? 'mt-1' : 'absolute right-full bottom-0 mr-1.5 pointer-coarse:static pointer-coarse:mr-0 pointer-coarse:mt-1', 'flex items-center gap-0.5 rounded-md px-0.5 text-foreground-3', REVEAL)}>
                          <IconButton icon="content_copy" label="Copy message" size={17} variant="action" box="icon-sm" onClick={() => copy(m.text)} />
                          {/* Editing sends the new question in place of this one and its answer, so not while one is being written. */}
                          <IconButton icon="edit" label="Edit message" size={17} variant="action" box="icon-sm" disabled={thinking} onClick={() => startEdit(m, [m.id, ...answerOf(b.at)])} />
                        </div>
                      </div>
                      {m.atts && m.atts.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap justify-end gap-1.5 self-end">
                          {m.atts.map((f, j) => (
                            f.fileId !== undefined
                              ? <FileChip key={f.name + j} fileId={f.fileId} icon={f.icon} name={f.name} meta={f.meta} tap={phone} />
                              : <AttachmentChip key={f.name + j} icon={f.icon} name={f.name} meta={f.meta} />
                          ))}
                        </div>
                      )}
                    </div>
                  )
                }
                if (b.kind === 'event') {
                  const m = b.m
                  // A stopped answer can be asked again (M11).
                  const stopped = isStoppedNote(m) ? questionBefore(b.at) : null
                  return (
                    <div key={m.id} data-chat-msg className={`group/msg relative flex flex-col ${mt}`}>
                      <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 self-center rounded-md px-2 py-0.5 text-center text-sm text-muted-foreground">
                        <span>{m.text}</span>
                        {stopped && (
                          <Button variant="soft" size="sm" disabled={thinking} className={cn('-my-0.5', phone && TAP)}
                            onClick={() => regenerate([stopped.q.id, ...stopped.between, m.id], { text: stopped.q.text, quote: stopped.q.quote, atts: stopped.q.atts })}>
                            <Icon name="refresh" size={16} />Retry
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                }
                const streaming = thinking && b.at + b.ms.length === msgs.length
                const endsTurn = !streaming
                const lastMsg = b.ms[b.ms.length - 1]
                const traceId = lastMsg.trace
                const tr = endsTurn ? traceOf(traceId) : null
                // A draft to approve is its own card after the answer's; everything else is in the answer's card.
                const inCard = b.ms.filter(x => x.part.type !== 'approval')
                const drafts = b.ms.filter(x => x.part.type === 'approval')
                return (
                  <div key={b.ms[0].id} data-chat-msg data-answer className={`group/msg relative flex flex-col ${mt}`}>
                    {/* The finished steps, collapsed above the card. */}
                    {tr && <StepsLine trace={tr} traceId={traceId} model={ctx.data.models.find(x => x.id === lastMsg.model)?.label} at={lastMsg.at} onToggle={onToggleLong} />}
                    {/* One white card per answer (D2): its text and tables inside, then its sources, and while it streams
                        the thinking line at its foot, so no second card shows. */}
                    {(inCard.length > 0 || streaming) && (
                      <div className={cn(CARD, phone ? 'px-4' : 'px-5')}>
                        {inCard.map(x => <AgentPart key={x.id} id={x.id} chat={openId ?? undefined} part={x.part} trace={x.trace} animate={seenNow.ids.has(x.trace)} onBusy={onBusy} />)}
                        {streaming && <Thinking text={thinkingText} />}
                        {endsTurn && <SourcesRow parts={inCard.map(x => x.part)} trace={tr} onToggle={onToggleLong} />}
                      </div>
                    )}
                    {drafts.map(x => (
                      <div key={x.id} className="mt-1.5 flex flex-col">
                        {x.part.type === 'approval' && <ApprovalCard problemId={x.part.problemId} />}
                      </div>
                    ))}
                    {/* The files this answer saved, each with Download. */}
                    {(() => {
                      const files = filesOfTurns(view, new Set(b.ms.map(m => m.trace)))
                      return files.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1.5 self-start">
                          {files.map(f => <FileChip key={f.fileId} fileId={f.fileId} icon={fileIcon(f.name)} name={f.name} meta={fileSize(f.bytes)} tap={phone} />)}
                        </div>
                      )
                    })()}
                    {/* The actions show once the turn is done, so the live log announces them once, not with every streamed part. */}
                    {endsTurn && answerBar(b)}
                  </div>
                )
              })}
              </div>

              {/* Before the answer's first part, its card holds the thinking line: the parts then fill that same card. */}
              {thinking && blocks.at(-1)?.kind !== 'turn' && (
                <div className={cn(CARD, 'mt-5.5', phone ? 'px-4' : 'px-5')}><Thinking text={thinkingText} /></div>
              )}
            </>
          )}
          {/* What the agent is doing, read out once per step (the visible line is in the card, hidden from the log). */}
          <div role="status" className="sr-only">{thinkingText}</div>
        </div>
      </div>

      {/* The bottom dock: toasts stack above it (data-bottom-dock). Kept in one tree slot across blank and active
          states so scroller/column stay observed and Composer never unmounts or drops focus on the first send. */}
      <div data-bottom-dock={!isBlank ? '' : undefined} className={cn('relative z-composer flex-none px-(--app-pad-x)', isBlank ? 'pt-6' : 'pb-5')}>
        <div className={cn('relative mx-auto w-full', isBlank ? 'max-w-today-column' : 'max-w-chat-column')}>
          {/* Centred above the box: clear of an answer's sources at the left and your messages at the right (M12). */}
          {!isBlank && away && (
            <div className="absolute bottom-full left-1/2 mb-2 -translate-x-1/2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <UiButton type="button" variant="outline" size="icon-round" aria-label="Jump to latest" onClick={toBottom}>
                    <Icon name="arrow_downward" size={18} />
                  </UiButton>
                </TooltipTrigger>
                <TooltipContent>Jump to latest</TooltipContent>
              </Tooltip>
            </div>
          )}
          {queue.length > 0 && (
            <div ref={queueList} role="list" aria-label="Queued messages" className="mb-2 flex flex-col gap-1.5">
              {queue.map(q => (
                <div key={q.id} role="listitem" className="min-w-0">
                  <QueuedChip q={q} editing={editingId !== undefined} onEdit={editQueued} onSendNow={x => chipAction(x, 'send')} onRemove={x => chipAction(x, 'remove')} />
                </div>
              ))}
            </div>
          )}
          {/* What holds the agent back, said where the person is about to type: a pause, a busy budget, a damaged session, a lost link. */}
          {notices}
          {/* Always there, so a screen reader hears each change to the queue. */}
          <div role="status" className="sr-only">{queueStatus}</div>
          <Composer variant="chat" showToolsLabel={isBlank && !phone} />
        </div>
      </div>

      {isBlank && (
        <div className="flex grow shrink-0 flex-col px-(--app-pad-x) pt-5 pb-8">
          <div className="mx-auto w-full max-w-today-column">
            <PromptBentoSlot suggestions={ctx.data.chat.suggestions} tools={readingTools(ctx)} onAsk={q => { void ask(q) }} showRoutine={ctx.S >= 1} />
          </div>
        </div>
      )}
      {replacing && (
        <Confirm label="Replace your draft?" title="Replace your draft?" action="Replace" onCancel={() => setReplacing(null)}
          closeFocus={() => (replaced.current ? document.querySelector<HTMLElement>('[data-composer] textarea') : null)}
          onConfirm={() => { replaced.current = true; putBack(replacing); setReplacing(null) }}>
          The queued message takes the place of what's in the box now.
        </Confirm>
      )}
    </div>
  )
}
