// The ask box on Today and in Chats: attach (also by paste and drop), tools chip, model picker, dictate, send or stop.
// In a chat it also queues a message while the answer streams, and shows "Editing" while a sent question is changed.
// On a phone both boxes keep attach and send: the tools and the model move into "+", the logo stack and dictate leave (M27).
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent, DragEvent, ReactElement } from 'react'
import { agent } from '../agent'
import type { Attachment } from '../agent/types'
import { dropFile, keepFile } from '../state/pending-files'
import { activeMode, emptyToolsNote, readingTools, thinkingModes, toolCounts, toolDetail } from '../state/derive'
import { openChatKey, openRun, useCtx, useUi } from '../state/store'
import { cn } from '@/lib/utils'
import { AttachmentChip, Button, Icon, IconButton, LogoCount, LogoTile, SwitchLook } from '../ui'
import { TAP } from '../ui/fields'
import { fileIcon, fileSize } from '@/lib/file-meta'
import { ATTACHMENT_NAME_TOO_LONG, NO_MODEL_NOTE, NO_MODEL_YET, attachmentNameTooLong } from '../screens/chat/notes'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Textarea } from '@/components/ui/textarea'

// The tooltip shows for keyboard focus only, not when a menu closes and puts focus back on its button.
function Tip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild onFocus={e => { if (!e.currentTarget.matches(':focus-visible')) e.preventDefault() }}>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

type Pop = null | 'attach' | 'tools' | 'model'
const PAGE_TITLES: Record<string, string> = { today: 'Today', chats: 'Chats', approvals: 'Approvals', routines: 'Routines', activity: 'Activity', apps: 'Tools', app: 'Tools', skills: 'Skills', skill: 'Skills', usage: 'Usage', settings: 'Settings' }
const MAX_LOGOS = 3

const MENU = 'box-border max-w-screen-gutter border-input'
const ATTACH_ITEM = 'rounded-xl px-2'
// Radix draws its own check or dot at the left of checkbox and radio items; these rows show their own marker.
const OWN_MARK = 'pl-2.5 [&>span:first-child]:hidden'
const ROUND = 'flex size-8.5 flex-none items-center justify-center rounded-full'
const SEND = 'flex size-9 flex-none items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-fill-strong disabled:text-muted-foreground'
// The bar over the field that says what Send will do (replying to an answer, editing a question).
const NOTE_BAR = 'mb-2 -ml-1.5 flex items-center gap-2 rounded-lg bg-accent py-1.75 pr-2 pl-2.5 text-sm text-foreground-3'

// Phase 1 limits on files a person adds. A file over them shows why and isn't added.
const MAX_FILES = 10
const MAX_MB = 20
/** The phone layout's breakpoint (App.tsx), read directly: the store's `phone` is set after the first render. */
export const PHONE_QUERY = '(max-width: 760px)'
/** A touch-only screen (no mouse, no hover): no Shift+Enter there, so Enter makes a new line and only Send sends.
 *  A narrow desktop window, or an iPad with a keyboard (it can hover), still sends on Enter. */
const TOUCH_QUERY = '(pointer: coarse) and (hover: none)'

/** Whether the device is touch-only, kept current when the query changes. */
function useTouchOnly() {
  const [touch, setTouch] = useState(() => window.matchMedia(TOUCH_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(TOUCH_QUERY)
    const on = () => setTouch(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return touch
}
/** Browsers without field-sizing get the field's height measured instead. */
const AUTO_SIZE = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')


export function Composer({ variant, showToolsLabel }: { variant: 'today' | 'chat'; showToolsLabel: boolean }) {
  const ctx = useCtx()
  const { data } = ctx
  // The tools the agent can read now: the tools menu lists these, each with its switch for this chat.
  const TOOL_KEYS = readingTools(ctx)
  const draft = useUi(s => (variant === 'today' ? s.todayDraft : s.chatDraft))
  // The agent is answering in this chat: Send becomes Stop. Today always sends (it starts a chat of its own).
  const running = useUi(s => variant === 'chat' && !!openRun(s))
  const chatKey = useUi(s => (s.fresh ? '' : s.chatId ?? ''))
  // A sent question being edited in this chat: Send puts it in place of the old one and its answer.
  const editing = useUi(s => variant === 'chat' && s.editMsg !== null && s.editMsg.chatId === openChatKey(s, ctx.data))
  const composerFocus = useUi(s => s.composerFocus)
  const modelMenuAsk = useUi(s => s.modelMenuAsk)
  const atts = useUi(s => s.atts)
  const replyTo = useUi(s => s.replyTo)
  const modelSel = useUi(s => s.modelSel)
  const toolOff = useUi(s => s.toolOff)
  const phone = useUi(s => s.phone)
  const touch = useTouchOnly()
  const page = useUi(s => s.page)
  const { patch, ask, go, stopRun, queueMessage, cancelEdit, sendEdit } = useUi.getState()
  // A phone's box, Today's and a chat's: the tools and the model sit in "+", no logo stack or dictate (M27).
  const slim = phone
  const editNote = useId()
  const toolsHead = useId()
  // The field's top edge fades once it scrolls (over 8 lines), so a cut line reads as more above (M12).
  const [scrolled, setScrolled] = useState(false)
  const [pop, setPop] = useState<Pop>(null)
  // A failed answer asked for the model menu (on a phone it lives in "+"). Only the chat's composer answers.
  const seenAsk = useRef(modelMenuAsk)
  useEffect(() => {
    if (modelMenuAsk === seenAsk.current) return
    seenAsk.current = modelMenuAsk
    if (variant !== 'today') setPop(slim ? 'attach' : 'model')
  }, [modelMenuAsk, slim, variant])
  // Limit notes belong to the chat they were shown in.
  const [rejectedIn, setRejectedIn] = useState<{ key: string; list: { name: string; reason: string }[] }>({ key: chatKey, list: [] })
  const rejected = rejectedIn.key === chatKey ? rejectedIn.list : []
  const setRejected = (list: { name: string; reason: string }[]) => setRejectedIn({ key: chatKey, list })
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const endDrag = () => { dragDepth.current = 0; setDragging(false) }
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const below = variant === 'today'

  const setDraft = (v: string) => patch(variant === 'today' ? { todayDraft: v } : { chatDraft: v })
  const addAtts = (list: Attachment[]) => { patch({ atts: [...useUi.getState().atts, ...list] }); setPop(null) }
  /** Files from the picker, a paste or a drop: the ones within the limits are added, the rest say why. */
  const takeFiles = (files: File[]) => {
    if (!files.length) return
    const have = useUi.getState().atts.length
    const ok: Attachment[] = []
    const bad: { name: string; reason: string }[] = []
    for (const file of files) {
      if (file.size > MAX_MB * 1e6) bad.push({ name: file.name, reason: `Over the ${MAX_MB} MB limit` })
      else if (attachmentNameTooLong(file.name)) bad.push({ name: file.name, reason: ATTACHMENT_NAME_TOO_LONG })
      else if (have + ok.length >= MAX_FILES) bad.push({ name: file.name, reason: `Only ${MAX_FILES} files per message` })
      // The real client keeps the file until the send, which uploads it; the demo's chip is only its name and size.
      else ok.push({ name: file.name, meta: fileSize(file.size), icon: fileIcon(file.name), ...(agent.uploadsFiles() ? { pending: keepFile(file) } : {}) })
    }
    if (ok.length) addAtts(ok)
    setRejected(bad)
  }
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (!files.length) return
    // A copied file can carry its name as text too; only that text would land in the field.
    e.preventDefault()
    takeFiles(files)
  }

  // A chat that opens takes focus, on desktop only: on a phone it would pop the keyboard on every navigation.
  useEffect(() => {
    if (variant === 'chat' && !window.matchMedia(PHONE_QUERY).matches) inputRef.current?.focus({ preventScroll: true })
  }, [variant, chatKey])

  // setComposerText({ focus: true }): focus the field with the caret after the text.
  useEffect(() => {
    if (!composerFocus) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [composerFocus])

  // No field-sizing: measure the field (its CSS max-height caps it at 8 lines), again when the window resizes or rotates.
  useLayoutEffect(() => {
    if (AUTO_SIZE) return
    const fit = () => {
      const el = inputRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [draft])

  // A drag that ends anywhere (dropped elsewhere, Escape, the window losing focus) clears the drop state. (App keeps
  // a file dropped outside the composer from opening in the browser.)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') endDrag() }
    window.addEventListener('drop', endDrag)
    window.addEventListener('dragend', endDrag)
    window.addEventListener('blur', endDrag)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('drop', endDrag)
      window.removeEventListener('dragend', endDrag)
      window.removeEventListener('blur', endDrag)
      window.removeEventListener('keydown', key)
    }
  }, [])

  // Stubs say what they are (M36).
  const notConnected = (what: string) => useUi.getState().showToast(`${what} isn't connected in this demo.`, { icon: 'info', ms: 4000 })
  const noModel = thinkingModes(data, ctx.agent.settings).every(m => !m.on)
  const canSend = !!draft.trim() && !noModel
  const send = () => {
    if (!draft.trim() || noModel) return
    setRejected([])
    // Editing goes first: it replaces the old question (and stops an answer to it). Over a running answer a message
    // waits above the box for its turn.
    if (editing) sendEdit()
    else if (running) queueMessage()
    else void ask(draft, { fromComposer: true })
  }

  // What the agent can read now (not paused, not disconnected, none on day one), less what's switched off for this chat.
  // The count agrees with Tools and the tool pages (M17).
  const counts = toolCounts(ctx)
  const onTools = TOOL_KEYS.filter(k => !toolOff[k])
  const logosOn = onTools.slice(0, MAX_LOGOS)
  const moreCount = onTools.length - logosOn.length
  // Tools switched off for this chat and tools the agent can't read (paused, disconnected) are different things: the
  // label says one or the other, never a count that mixes them.
  // Where an order, product or customer can come from: the tools that hold them and that the agent can read now.
  const attachExample = data.tools.attachExamples?.[0]
  const holders = TOOL_KEYS.filter(k => attachExample?.sources.includes(k)).map(k => toolDetail(data, k).name)
  const orderSources = holders.length < 2 ? `From ${holders[0] ?? 'your connected tools'}` : `From ${holders.slice(0, -1).join(', ')} or ${holders[holders.length - 1]}`
  const offHere = TOOL_KEYS.length - onTools.length
  const emptyTools = TOOL_KEYS.length === 0 ? emptyToolsNote(data) : null
  const claimNone = emptyTools?.kind === 'none'
  const toolsLabel = counts.connected === 0 ? (claimNone ? 'No tools connected yet' : '')
    : offHere > 0 ? `${onTools.length} of ${TOOL_KEYS.length} tools on in this chat`
      : counts.reading < counts.connected ? `${counts.reading} of ${counts.connected} tools connected` : `${counts.reading} tools connected`
  // The logos and their +N already say how many tools are read, so the plain "6 tools connected" isn't shown; the label
  // shows only when it says what the logos can't: none connected, some turned off in this chat, or some not read yet.
  // The button's name always carries it.
  const toolsNote = claimNone || offHere > 0 || (counts.connected > 0 && counts.reading < counts.connected)
  const toolsName = `${logosOn.length ? `${logosOn.map(k => toolDetail(data, k).name).join(', ')}${moreCount > 0 ? ` +${moreCount} ` : ', '}` : ''}${toolsLabel}`
  const everyMode = thinkingModes(data, ctx.agent.settings)
  const modes = everyMode.filter(m => m.on)
  // A model the person picked that an Admin has since switched off stays in the list, greyed, until they pick another.
  const offPick = everyMode.find(m => !m.on && m.id === modelSel)
  const listed = offPick ? [offPick, ...modes] : modes
  const sel = activeMode(data, ctx.agent.settings, modelSel)?.id ?? ''
  const modelLabel = modes.find(m => m.id === sel)?.label ?? ''

  // The tools switches for this chat and Manage tools: the tools menu, or "+" on a phone.
  const toolItems = (
    <>
      <DropdownMenuLabel id={toolsHead} className={cn('text-sm font-normal', slim ? 'px-2.5 pt-2 pb-1 text-muted-foreground' : 'pt-2 pb-1.5')}>Tools read in this chat</DropdownMenuLabel>
      <DropdownMenuGroup aria-labelledby={toolsHead}>
      {emptyTools && (
        <DropdownMenuLabel className="pt-0 pb-2 text-sm font-normal text-muted-foreground">{emptyTools.text}</DropdownMenuLabel>
      )}
      {TOOL_KEYS.map(k => {
        const on = !toolOff[k]
        return (
          <DropdownMenuCheckboxItem key={k} checked={on} className={OWN_MARK}
            onSelect={e => e.preventDefault()} onCheckedChange={() => patch({ toolOff: { ...toolOff, [k]: on } })}>
            <LogoTile k={k} size="sm" />
            <span className="flex-1 text-base">{toolDetail(data, k).name}</span>
            <SwitchLook on={on} small />
          </DropdownMenuCheckboxItem>
        )
      })}
      </DropdownMenuGroup>
      <DropdownMenuSeparator className="mx-1.5 my-1" />
      <DropdownMenuItem className="px-2.5 py-2 text-sm font-strong" onSelect={() => go('apps')}>Manage tools →</DropdownMenuItem>
    </>
  )

  const side = below ? 'bottom' : 'top'
  const menuProps = { side, sideOffset: 8, collisionPadding: 16 } as const
  const onOpen = (name: Exclude<Pop, null>) => (open: boolean) => setPop(open ? name : p => (p === name ? null : p))

  return (
    <div data-composer data-dragging={dragging || undefined}
      className={cn('relative z-composer box-border w-full rounded-2xl border border-border bg-card pt-3 pb-2.5 pr-2.5 pl-4.5 text-left shadow-float has-[>textarea:focus]:border-ring/45 has-[>textarea:focus]:shadow-composer-focus',
        variant === 'today' ? 'max-w-today-column' : 'mx-auto mb-safe-bottom max-w-chat-column',
        dragging && 'border-dashed border-border-strong has-[>textarea:focus]:border-border-strong')}
      onDragEnter={e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth.current++; setDragging(true) }}
      onDragOver={e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={e => { if (!hasFiles(e)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false) }}
      onDrop={e => { if (!hasFiles(e)) return; e.preventDefault(); endDrag(); takeFiles(Array.from(e.dataTransfer.files)) }}>
      {editing && (
        <div className={NOTE_BAR}>
          <Icon name="edit" size={15} />
          <b id={editNote} className="min-w-0 flex-1 font-semibold text-foreground">Editing your message</b>
          <Button variant="ghost" size="sm" onClick={cancelEdit} className={cn('-my-1.5 flex-none', phone && TAP)}>Cancel</Button>
        </div>
      )}
      {noModel && (
        <div className={NOTE_BAR}>
          <Icon name="info" size={15} />
          <b className="min-w-0 flex-1 font-semibold text-foreground">{NO_MODEL_NOTE}</b>
        </div>
      )}
      {variant === 'chat' && replyTo && (
        <div className={NOTE_BAR}>
          <Icon name="reply" size={15} />
          <b className="font-semibold whitespace-nowrap text-foreground">Replying to Inhouse agent</b>
          <span className="ellipsis min-w-0 flex-1">{replyTo}</span>
          <IconButton icon="close" label="Stop replying" size={16} box="icon-sm" onClick={() => patch({ replyTo: null })} className={cn('-my-1.5 flex-none', phone && TAP)} />
        </div>
      )}
      {(atts.length > 0 || rejected.length > 0) && (
        <div className="mb-2.5 -ml-1.5 flex flex-wrap gap-1.5">
          {atts.map((a, i) => (
            <AttachmentChip key={a.name + i} icon={a.icon} name={a.name} meta={a.meta} tap={phone} onRemove={() => { if (a.pending !== undefined) dropFile(a.pending); patch({ atts: atts.filter((_, j) => j !== i) }) }} />
          ))}
          {rejected.length > 0 && (
            // One alert for all the rejected files, so a screen reader reads them together once.
            <div role="alert" className="contents">
              {rejected.map((r, i) => (
                <AttachmentChip key={r.name + i} error icon="error" name={r.name} meta={r.reason} tap={phone} onRemove={() => setRejected(rejected.filter((_, j) => j !== i))} />
              ))}
            </div>
          )}
        </div>
      )}
      <Textarea ref={inputRef} rows={1} value={draft} onChange={e => setDraft(e.target.value)} onPaste={onPaste} enterKeyHint={touch ? 'enter' : 'send'}
        aria-describedby={editing ? editNote : undefined}
        data-scrolled={scrolled || undefined} onScroll={e => setScrolled(e.currentTarget.scrollTop > 0)}
        onKeyDown={e => {
          // Escape leaves editing, the old question untouched.
          if (e.key === 'Escape' && editing) { e.preventDefault(); e.stopPropagation(); cancelEdit(); return }
          // Safari ends an IME composition with a keydown of keyCode 229 and isComposing false: that Enter isn't a send.
          if (e.key !== 'Enter' || e.shiftKey || touch || e.nativeEvent.isComposing || e.keyCode === 229) return
          e.preventDefault(); send()
        }}
        placeholder={variant === 'today' && !claimNone ? (phone ? 'Ask about orders, stock or numbers' : 'Ask about orders, stock, customers or numbers') : 'Message Inhouse'} aria-label={variant === 'today' ? 'Ask Inhouse' : 'Message Inhouse'}
        className="block max-h-composer-input min-h-8.5 resize-none overflow-y-auto rounded-none border-0 bg-transparent p-0 py-(--app-composer-input-pad-y) text-md text-foreground shadow-none outline-0 focus:shadow-none data-scrolled:mask-(--app-composer-fade)" />

      <div className="relative mt-2.5 flex items-center gap-2">
        <input ref={fileRef} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e: ChangeEvent<HTMLInputElement>) => {
          takeFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }} />
        <DropdownMenu modal={false} open={pop === 'attach'} onOpenChange={onOpen('attach')}>
          <Tip label="Attach">
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={slim ? 'Attach, tools and model' : 'Attach'} className={cn(ROUND, 'text-foreground-2', pop === 'attach' ? 'bg-fill-hover' : 'bg-secondary hover:bg-fill-hover')}>
                <Icon name="add" size={20} />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent {...menuProps} align="start" alignOffset={-8} className={cn(MENU, 'w-menu-attach')}>
            <DropdownMenuItem className={cn(ATTACH_ITEM, 'cursor-pointer')} onSelect={() => fileRef.current?.click()}>
              <AttachRow icon="upload_file" title="Upload files" sub="PDF, spreadsheets, images, invoices" />
            </DropdownMenuItem>
            <DropdownMenuItem className={ATTACH_ITEM} onSelect={() => notConnected('Google Drive')}>
              <AttachRow icon="add_to_drive" title="From Google Drive" sub="Sheets, docs and PDFs you can open" />
            </DropdownMenuItem>
            {attachExample && (
              <DropdownMenuItem className={ATTACH_ITEM} onSelect={() => addAtts([{ name: attachExample.name, meta: attachExample.meta, icon: attachExample.icon }])}>
                <AttachRow icon={attachExample.icon} title={attachExample.label ?? 'A record from your tools'} sub={orderSources} />
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator className="mx-1.5 my-1" />
            <DropdownMenuItem className={ATTACH_ITEM} onSelect={() => addAtts([{ name: `Screenshot of ${PAGE_TITLES[page] ?? 'this page'}`, meta: 'PNG · just now', icon: 'screenshot_region' }])}>
              <AttachRow icon="screenshot_region" title="Screenshot of this page" sub="Useful when something looks wrong" />
            </DropdownMenuItem>
            {slim && (
              <>
                <DropdownMenuSeparator className="mx-1.5 my-1" />
                {toolItems}
                {modes.length > 0 && (
                  <>
                    <DropdownMenuSeparator className="mx-1.5 my-1" />
                    <DropdownMenuLabel className="px-2.5 pt-2 pb-1 text-sm font-normal text-muted-foreground">Model</DropdownMenuLabel>
                    <ModelItems modes={listed} sel={sel} onPick={id => patch({ modelSel: id })} />
                  </>
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {!slim && <DropdownMenu modal={false} open={pop === 'tools'} onOpenChange={onOpen('tools')}>
          <Tip label="Tools read in this chat">
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={toolsName ? `Tools read in this chat: ${toolsName}` : 'Tools read in this chat'}
                className={cn('flex h-8.5 min-w-0 items-center gap-2.5 rounded-full pr-2.5 pl-1.5 hover:bg-accent', pop === 'tools' && 'bg-accent')}>
                <span className="flex flex-none">
                  {logosOn.map(k => (
                    <LogoTile key={k} k={k} size="sm" round className="-mr-1.25" />
                  ))}
                  {moreCount > 0 && (
                    <LogoCount n={moreCount} size="sm" data-testid="tools-more" className="ml-1.75" />
                  )}
                </span>
                {/* The label gives way first when the row is tight (768px), so Send stays inside the box (M13). */}
                {showToolsLabel && toolsNote && <>{' '}<span className="ellipsis ml-1 min-w-0 text-xs text-muted-foreground">{toolsLabel}</span></>}
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent {...menuProps} align="start" alignOffset={-12} className={cn(MENU, 'w-menu-tools')}>
            {toolItems}
          </DropdownMenuContent>
        </DropdownMenu>}
        <div className="min-w-0 flex-1" />
        {!slim && modes.length > 0 && <DropdownMenu modal={false} open={pop === 'model'} onOpenChange={onOpen('model')}>
          <Tip label="Model">
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={`Model: ${modelLabel}`}
                className={cn('flex h-8 flex-none items-center gap-1 rounded-full pr-2 pl-3 text-sm whitespace-nowrap text-foreground-2 hover:bg-accent', pop === 'model' && 'bg-accent')}>
                {modelLabel}<Icon name="expand_more" size={17} className="text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent {...menuProps} align="end" alignOffset={-46} className={cn(MENU, phone ? 'w-menu-mode-phone' : 'w-menu-mode')}>
            <ModelItems modes={listed} sel={sel} onPick={id => patch({ modelSel: id })} />
            <div className="mt-1 border-t border-divider px-2.5 pt-2 pb-1.5 text-xs text-muted-foreground">Admins choose which models the team can use, in Settings.</div>
          </DropdownMenuContent>
        </DropdownMenu>}
        {!slim && (
          <Tip label="Dictate">
            <button type="button" aria-label="Dictate" onClick={() => notConnected('Dictation')}
              className={cn(ROUND, 'bg-secondary text-foreground-2 hover:bg-fill-hover')}>
              <Icon name="mic" size={19} />
            </button>
          </Tip>
        )}
        {/* While the answer streams Stop keeps Send's place, and a typed message gets its own button beside it: it
            waits above the box for the answer to end (H8). Editing sends at once, in place of the old question. */}
        {running && canSend && (
          <Tip label={editing ? 'Send' : 'Send when this answer ends'}>
            <button type="button" aria-label={editing ? 'Send' : 'Queue message'} onClick={send} className={cn(ROUND, 'size-9 bg-secondary text-foreground-2 hover:bg-fill-hover')}>
              <Icon name={editing ? 'arrow_upward' : 'schedule_send'} size={19} weight={400} />
            </button>
          </Tip>
        )}
        {running ? (
          <Tip label="Stop">
            <button type="button" data-composer-send aria-label="Stop" onClick={() => stopRun()} className={SEND}>
              <Icon name="stop" size={19} weight={400} fill />
            </button>
          </Tip>
        ) : (
          <Tip label={noModel ? NO_MODEL_YET : 'Send'}>
            <button type="button" data-composer-send aria-label={noModel ? `Send, ${NO_MODEL_YET}` : 'Send'} onClick={send} disabled={!canSend} className={SEND}>
              <Icon name="arrow_upward" size={19} weight={400} />
            </button>
          </Tip>
        )}
      </div>
    </div>
  )
}

/** The model choices, in the model menu and, on a phone, in "+". */
function ModelItems({ modes, sel, onPick }: { modes: { id: string; label: string; model: string; sub: string; on?: boolean }[]; sel: string; onPick: (id: string) => void }) {
  return (
    <DropdownMenuRadioGroup aria-label="Model" value={sel} onValueChange={onPick}>
      {modes.map(m => (
        <DropdownMenuRadioItem key={m.id} value={m.id} disabled={m.on === false} className={cn(OWN_MARK, 'py-2')}>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium">{m.label}</span>
            <span className="block text-xs text-muted-foreground">{m.on === false ? `${m.model} · Switched off by your Admin` : `${m.model} · ${m.sub}`}</span>
          </span>
          {sel === m.id && <Icon name="check" size={18} className="text-foreground" />}
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  )
}

function AttachRow({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <>
      <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-accent"><Icon name={icon} size={18} /></span>
      <span className="min-w-0 flex-1 text-left">
        <span className="block text-base font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{sub}</span>
      </span>
    </>
  )
}
