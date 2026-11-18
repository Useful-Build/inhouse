// Chats: the thread, hover actions under each agent turn and your own messages, the "···" menu, Jump to latest and the ask box.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { agent } from '../agent'
import type { ChatMessage } from '../agent/types'
import { Composer } from '../components/Composer'
import { chatMessages, fmtSeconds, listNames, readingTools, toolDetail } from '../state/derive'
import { fmtTime } from '../agent/clock'
import { cn } from '@/lib/utils'
import { openChatKey, openRun, useCtx, useUi } from '../state/store'
import { Confirm, TAP } from '../ui/fields'
import { AgentMark, AttachmentChip, Button, Icon, IconButton, MenuItem, StageTag } from '../ui'
import { Button as UiButton } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentPart } from './chat/Parts'
import { ChatList } from './chat/ChatList'
import { SuggestionChip } from '../ui/chat'
import { copyText } from './chat/copy'

// The row of actions under a message: one 28px step, the icon buttons as IconButton's `action` look at `icon-sm`.
const AB = 'inline-flex h-7 min-w-7 items-center justify-center rounded-md text-foreground-3 hover:bg-fill-hover aria-expanded:bg-fill-hover'

const isAgent = (m: ChatMessage | undefined): m is Extract<ChatMessage, { role: 'agent' }> => m?.role === 'agent'
/** Within this many px of the bottom, new messages and thinking steps keep the view at the bottom. */
const NEAR_BOTTOM = 80
/** Shown on hover and focus, always on a phone or a touch screen. */
const REVEAL = 'opacity-0 transition-opacity duration-120 group-focus-within/msg:opacity-100 group-hover/msg:opacity-100 pointer-coarse:opacity-100 data-[on=1]:opacity-100'
/** An answer's action bar: its ground shows with the actions (REVEAL); its steps line shows on every answer. */
const BAR_GROUND = 'transition-shadow duration-120 data-[on=1]:bg-background data-[on=1]:shadow-page-xs group-hover/msg:bg-background group-hover/msg:shadow-page-xs group-focus-within/msg:bg-background group-focus-within/msg:shadow-page-xs pointer-coarse:bg-background pointer-coarse:shadow-page-xs'

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

function Thread() {
  const ctx = useCtx()
  const { fresh, chatId, extras, hidden, phone, feedback } = useUi()
  const run = useUi(openRun)
  const thinking = !!run
  const thinkingText = run?.text ?? ''
  const { ask, openTrace, patch, showToast, openTeam, branchChat, regenerate, rateAnswer, go, deleteMessages } = useUi.getState()
  const [menuId, setMenuId] = useState<string | null>(null)
  // Edit over a draft asks first.
  const [editing, setEditing] = useState<Extract<ChatMessage, { role: 'user' }> | null>(null)
  // Replace puts focus in the composer; closing the question must not take it back to the Edit button.
  const replaced = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  // Null for a new chat, and when there are no chats at all (day one): the thread then starts empty.
  const openId = openChatKey({ fresh, chatId }, ctx.data)
  const all = useMemo(() => (openId === null ? [] : chatMessages(ctx, openId)).concat(extras), [ctx, openId, extras])
  const msgs = all.filter(m => !hidden[m.id])

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
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    if (el.scrollTop === pinnedTop.current) { pinnedTop.current = -1; return }
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
    setAwayIn(stick.current ? null : visit)
  }
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

  const turnOf = (i: number) => {
    const out: Extract<ChatMessage, { role: 'agent' }>[] = []
    for (let j = i; j >= 0; j--) { const m = msgs[j]; if (!isAgent(m)) break; out.unshift(m) }
    return out
  }
  const turnText = (i: number) => turnOf(i).flatMap(m => (m.part.type === 'text' ? [m.part.text] : [])).join('\n\n') || "Inhouse agent's answer"

  const copy = (text: string) => copyText(text)
  /** Your question back in the composer with its quote and files, to change and send as a new question. */
  const putBack = (m: Extract<ChatMessage, { role: 'user' }>) => {
    patch({ replyTo: m.quote ?? null, atts: m.atts ?? [] })
    useUi.getState().setComposerText(m.text, { focus: true })
  }
  // A draft, files or a quote in the composer would be lost: ask first.
  const editMessage = (m: Extract<ChatMessage, { role: 'user' }>) => {
    const s = useUi.getState()
    replaced.current = false
    if (s.chatDraft.trim() || s.atts.length || s.replyTo) setEditing(m); else putBack(m)
  }
  const readAloud = (text: string) => {
    const failed = () => showToast("Reading aloud isn't available in this browser.", { icon: 'error' })
    if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') { failed(); return }
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.onstart = () => showToast('Reading aloud')
      u.onerror = e => {
        // Starting a new reading cancels the old one: that is not a failure.
        if (e.error === 'canceled' || e.error === 'interrupted') return
        console.warn('Inhouse: read aloud failed.', e.error)
        failed()
      }
      speechSynthesis.cancel(); speechSynthesis.speak(u)
    } catch (e) { console.warn('Inhouse: read aloud is not available here.', e); failed() }
  }

  const bubbleMax = phone ? 'max-w-22/25' : 'max-w-18/25'

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-auto px-(--app-pad-x) pt-2 pb-14">
        <div ref={column} className="mx-auto flex max-w-chat-column flex-col">
          {msgs.length === 0 && (
            <div className="flex flex-col items-center pt-chat-empty-top text-center">
              <h2 className="rounded-3xl bg-background px-3.5 text-3xl leading-title font-medium tracking-title shadow-page-xl">What do you want to know?</h2>
              {connected.length > 0
                ? <p className="mt-2.5 rounded-xl bg-background px-2.5 text-md text-foreground-3 shadow-page-lg">Your Inhouse agent reads {listNames(connected)}.</p>
                : <>
                    <p className="mt-2.5 rounded-xl bg-background px-2.5 text-md text-foreground-3 shadow-page-lg">No tools are connected yet.</p>
                    <Button variant="outline" className="mt-3" onClick={() => go('apps')}>Connect tools</Button>
                  </>}
              <div className="mt-5.5 flex flex-wrap justify-center gap-2">
                {ctx.data.chat.suggestions.map(t => <SuggestionChip key={t} question={t} onAsk={q => { void ask(q) }} />)}
              </div>
            </div>
          )}

          {/* The conversation as a log, so screen readers hear each new answer once (not every thinking step).
              Keyed by chat, so opening a chat doesn't read out its whole history. */}
          <div key={threadKey} role="log" aria-label="Conversation" className="flex flex-col">
          {msgs.map((m, i) => {
            const prev = msgs[i - 1], next = msgs[i + 1]
            const mt = i === 0 ? 'mt-2' : isAgent(prev) && isAgent(m) ? 'mt-1.5' : m.role === 'event' ? 'mt-3.5' : 'mt-5.5'
            const endsTurn = isAgent(m) && !isAgent(next)
            const menuOpen = menuId === m.id
            return (
              <div key={m.id} data-chat-msg className={`group/msg relative flex flex-col ${mt}`}>
                {m.role === 'user' && (
                  <>
                    {/* Desktop: the actions sit beside the bubble, out of the flow, so they cost no space at rest.
                        Phone and touch: in the flow under the bubble, always visible. */}
                    <div className={`relative flex flex-col items-end self-end ${bubbleMax}`}>
                    <div className="rounded-3xl border border-border bg-card px-4.5 py-3 text-md leading-prose whitespace-pre-wrap wrap-anywhere">
                      {m.quote && (
                        <div className="mb-2 flex gap-2 overflow-hidden rounded-lg bg-fill px-2.5 py-1.5 text-sm whitespace-nowrap text-foreground-3">
                          <Icon name="reply" size={15} />
                          <span className="overflow-hidden text-ellipsis">{m.quote}</span>
                        </div>
                      )}
                      {m.text}
                    </div>
                    <div data-on={phone ? '1' : undefined} className={cn(phone ? 'mt-1' : 'absolute right-full bottom-0 mr-1.5 pointer-coarse:static pointer-coarse:mr-0 pointer-coarse:mt-1', 'flex items-center gap-0.5 rounded-md bg-background px-0.5 text-foreground-3 shadow-page-xs', REVEAL)}>
                      <IconButton icon="content_copy" label="Copy message" size={17} variant="action" box="icon-sm" onClick={() => copy(m.text)} />
                      <IconButton icon="edit" label="Edit message" size={17} variant="action" box="icon-sm" onClick={() => editMessage(m)} />
                    </div>
                    </div>
                    {m.atts && m.atts.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap justify-end gap-1.5 self-end">
                        {m.atts.map((f, k) => (
                          <AttachmentChip key={f.name + k} icon={f.icon} name={f.name} meta={f.meta} />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {m.role === 'event' && (
                  <div className="self-center rounded-md bg-background px-2 py-0.5 text-center text-sm text-muted-foreground shadow-page-sm">{m.text}</div>
                )}

                {isAgent(m) && <AgentPart part={m.part} trace={m.trace} />}

                {/* The actions show once the turn is done, so the live log announces them once, not with every streamed part. */}
                {isAgent(m) && endsTurn && !(thinking && !next) && (() => {
                  const tr = agent.getTrace(m.trace)
                  const failed = m.part.type === 'error'
                  // Mode, step count, time taken and when it answered, as far as they're known.
                  const modelLabel = m.model ? ctx.data.models.find(x => x.id === m.model)?.label : undefined
                  const stepsLine = tr ? [modelLabel, `${tr.steps.length - 1} steps`, fmtSeconds(tr.duration), m.at === undefined ? undefined : fmtTime(new Date(m.at))].filter(Boolean).join(' · ') : ''
                  const steps = tr && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className={cn(AB, 'gap-2 pr-1.5 pl-2.5 text-muted-foreground hover:text-foreground', phone && TAP)} onClick={() => openTrace(m.trace)}>
                          <span className="tabular-nums">{stepsLine}</span><Icon name="chevron_right" size={17} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>See every step</TooltipContent>
                    </Tooltip>
                  )
                  // The steps line's slot follows only whether this is the newest answer (or a phone), never the menu:
                  // opening More must not move it, or the More button would slide away from under the pointer.
                  const latest = !next || phone
                  const on = menuOpen || latest ? '1' : undefined
                  // An error turn has no answer to act on, only the run's steps.
                  if (failed) {
                    return steps && (
                      <div className="mt-1.5 flex items-center self-start rounded-md bg-background text-sm text-foreground-3 shadow-page-xs">{steps}</div>
                    )
                  }
                  const txt = turnText(i)
                  const turn = turnOf(i)
                  const question = msgs[i - turn.length]
                  // Thumbs belong to the turn, keyed by its first answer message: it doesn't change while the turn streams.
                  const turnId = turn[0].id
                  // A stopped turn's note goes with it when it is asked again.
                  const tail = next?.role === 'event' ? [next.id] : []
                  const S = ctx.S
                  const items: { icon: string; t: string; go: () => void; destructive?: boolean; sep?: boolean; locked?: boolean }[] = [
                    { icon: 'graphic_eq', t: 'Read aloud', go: () => readAloud(txt) },
                    { icon: 'tag', t: 'Send to Slack', go: () => { if (S >= 1) showToast("Send to Slack isn't connected in this demo.", { icon: 'info', ms: 4000 }) }, locked: S < 1 },
                    { icon: 'call_split', t: 'Branch from here', sep: true, go: () => { branchChat(msgs.slice(0, i + 1)); showToast('Started a new chat from this point') } },
                    { icon: 'flag', t: 'Report a wrong answer', go: () => openTeam('bug', 'This answer looks wrong: "' + txt.slice(0, 120) + '"') },
                    // Undo works from any chat: the store finds this chat wherever it is by then (M5).
                    { icon: 'delete', t: 'Delete', destructive: true, sep: true, go: () => { if (openId !== null) deleteMessages(openId, [...turn.map(x => x.id), ...tail]) } },
                  ]
                  return (
                    <div data-on={on}
                      className={cn('relative mt-1.5 flex flex-wrap items-center gap-0.5 self-start rounded-md pl-1 text-sm text-foreground-3', BAR_GROUND)}>
                      {/* Actions hidden at rest (an earlier answer): the steps line goes first, at the row's left edge, so
                          nothing moves when they show on hover. */}
                      {!latest && steps}
                      <span data-on={on} data-answer-actions className={cn('flex flex-wrap items-center gap-0.5', REVEAL)}>
                      <IconButton icon="reply" label="Reply" size={17} variant="action" box="icon-sm" onClick={() => patch({ replyTo: txt.slice(0, 140) })} />
                      <IconButton icon="content_copy" label="Copy message" size={17} variant="action" box="icon-sm" onClick={() => copy(txt)} />
                      {question?.role === 'user' && (
                        <IconButton icon="refresh" label="Regenerate" size={17} variant="action" box="icon-sm" disabled={thinking}
                          onClick={() => regenerate([question.id, ...turn.map(x => x.id), ...tail], { text: question.text, quote: question.quote, atts: question.atts })} />
                      )}
                      <Rate icon="thumb_up" label="Good answer" on={feedback[turnId] === 'up'} onClick={() => rateAnswer(turnId, 'up', txt)} />
                      <Rate icon="thumb_down" label="Bad answer" on={feedback[turnId] === 'down'} onClick={() => rateAnswer(turnId, 'down', txt)} />
                      <DropdownMenu modal={false} open={menuOpen} onOpenChange={o => setMenuId(o ? m.id : null)}>
                        <DropdownMenuTrigger asChild>
                          <IconButton icon="more_horiz" label="More" size={18} variant="action" box="icon-sm" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" alignOffset={-4} collisionPadding={16} aria-label="Message actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input"
                          // A window opened by an item ("Report a wrong answer") takes focus itself.
                          onCloseAutoFocus={e => { if (useUi.getState().pop === 'team') e.preventDefault() }}>
                          {items.map(it => (
                            <Fragment key={it.t}>
                              {it.sep && <DropdownMenuSeparator className="mx-0 my-1" />}
                              <MenuItem variant={it.destructive ? 'destructive' : 'default'} locked={it.locked}
                                onSelect={it.go}>
                                <Icon name={it.icon} size={18} />
                                <span className="flex-1">{it.t}</span>
                                {it.locked && <StageTag tag="Act" icon={false} />}
                              </MenuItem>
                            </Fragment>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      </span>
                      {latest && steps}
                    </div>
                  )
                })()}
              </div>
            )
          })}
          </div>

          {thinking && (
            <div role="status" className="mt-4.5 box-border flex max-w-full items-center gap-3 self-start rounded-3xl bg-card px-4 py-2.5">
              <AgentMark />
              <span className="min-w-0 text-base text-foreground-3">{thinkingText}</span>
            </div>
          )}
        </div>
      </div>

      {/* The bottom dock: toasts stack above it (data-bottom-dock). */}
      <div data-bottom-dock className="relative z-composer px-(--app-pad-x) pb-5">
        {away && (
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
        <Composer variant="chat" showToolsLabel={!phone && msgs.length === 0} />
      </div>
      {editing && (
        <Confirm label="Replace your draft?" title="Replace your draft?" action="Replace" onCancel={() => setEditing(null)}
          closeFocus={() => (replaced.current ? document.querySelector<HTMLElement>('[data-composer] textarea') : null)}
          onConfirm={() => { replaced.current = true; putBack(editing); setEditing(null) }}>
          The message you're editing takes the place of what's in the box now.
        </Confirm>
      )}
    </div>
  )
}
