// Skills list.
import { agent, demo } from '../agent'
import { keepUnitsTogether } from '../agent/clock'
import { STAGE_TAGS } from '../state/derive'
import { useCtx, useUi } from '../state/store'
import type { SkillDef } from '../agent'
import { useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { Button, CardGrid, DetailList, EmptyState, Icon, IconButton, IconTile, Page, PageHeader, SectionHeader, Segmented, StageTag, Switch } from '../ui'
import { SearchBox, TAP } from '../ui/fields'
import { NO_MOTION } from '../ui/motion'
import { shownSkillTab, skillFacts, skillTabs } from '../lib/product-flow'
import { claimTrigger, rememberTrigger, restoreFocus, keepForToast } from '../ui/dialogs'

const SECTION_HEAD = 'mb-1.5'
/** Where a skill's on switch is saved in `AgentState.toggles`. Missing means on. */
const skillKey = (name: string) => `s:${name}`

export function Skills() {
  const { S, agent: st, data } = useCtx()
  const loading = data.status === 'loading'
  const tab = shownSkillTab(demo !== null, useUi(s => s.skillTab))
  const patch = useUi(s => s.patch)
  const newChat = useUi(s => s.newChat)
  const openTeam = useUi(s => s.openTeam)
  const showToast = useUi(s => s.showToast)
  const phone = useUi(s => s.phone)
  const [openKey, setOpenKey] = useState<string | null>(null)

  /** Name plus how many times it came before in the same list: unique, and steady while nothing is added in front. */
  const keyer = () => { const seen = new Map<string, number>(); return (name: string) => { const n = seen.get(name) ?? 0; seen.set(name, n + 1); return `${name}|${n}` } }
  const listKey = keyer()
  const suggestKey = keyer()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const hit = (name: string, desc: string) => !needle || `${name} ${desc}`.toLowerCase().includes(needle)
  const list = st.skillsExtra.concat(data.skills).filter(s => (tab === 'all' || (tab === 'mine' ? s.mine : !s.mine)) && hit(s.n, s.d))
  // The open skill, found again by its key (the list is never filtered while its details show).
  const openKeyer = keyer()
  const openSkill = list.find(s => openKeyer(s.n) === openKey)
  const suggestions = data.skillSuggestions.filter(s => hit(s.n, s.d))

  return (
    <Page>
      <PageHeader title="Skills" description="Instructions that teach your Inhouse agent a job. Your Inhouse team writes and tests each one."
        actions={<Segmented label="Show skills" value={tab} options={skillTabs(demo !== null)} onChange={v => patch({ skillTab: v })} className={cn(phone && '*:min-h-11')} />} />
      <div className="mt-5.5 flex gap-2.5">
        <SearchBox value={query} onChange={setQuery} placeholder="Search skills" label="Search skills" />
        {/* The product has no skill maker: a new skill is a request to the Inhouse team. */}
        {demo
          ? <Button size="lg" onClick={() => newChat('Create a skill that ')}><Icon name="add" size={18} />Create skill</Button>
          : <Button size="lg" onClick={() => openTeam('job')}><Icon name="add" size={18} />Request a skill</Button>}
      </div>
      <Separator className="mt-6.5 mb-4 bg-border" />
      <SectionHeader title="Your skills" count={list.length} className={SECTION_HEAD} />
      {list.length === 0 && (loading
        ? <EmptyState>Still reading your tools. Your skills show here in a moment.</EmptyState>
        : <EmptyState variant="inline">{needle ? `No skills match "${query.trim()}".` : 'No skills in this list.'}</EmptyState>)}
      <CardGrid size="lg" variant="rows">
        {list.map(s => {
          const locked = S < s.need
          const key = listKey(s.n)
          const off = !!demo && !locked && st.toggles[skillKey(s.n)] === false
          return (
            <div key={key} className="relative flex items-start gap-3.5 rounded-xl p-3 hover:bg-card">
              <IconTile icon={s.icon} iconSize={22} size="xl" tone={locked ? 'locked' : s.need === 2 && S === 2 ? 'brand' : 'ink'} />
              <div className="min-w-0 flex-1">
                <div className={`flex items-center gap-2 text-md font-strong ${locked ? 'text-foreground-3' : ''}`}>
                  {/* The name opens the details; its tap area covers the whole row. */}
                  <button type="button" aria-haspopup="dialog" onClick={() => { rememberTrigger(); setOpenKey(key) }} className="min-w-0 text-left after:absolute after:inset-0 after:rounded-xl">{s.n}</button>
                  {locked && <StageTag tag={STAGE_TAGS[s.need]} />}
                  {off && <Badge variant="muted">Off</Badge>}
                </div>
                <div className="text-sm text-pretty text-muted-foreground">{keepUnitsTogether(s.d)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{[s.by, s.used].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          )
        })}
      </CardGrid>
      {openSkill && <SkillSheet skill={openSkill} phone={phone} onClose={() => setOpenKey(null)} />}
      {suggestions.length > 0 && <>
      <Separator className="mt-4.5 mb-4 bg-border" />
      <SectionHeader title={data.skillSuggestionsTitle ?? 'Suggested for you'} className={SECTION_HEAD} />
      <CardGrid size="lg" variant="rows">
        {suggestions.map(s => {
          const req = !!st.requestedSkills[s.n]
          const add = () => {
            agent.requestSkill(s.n)
            showToast(`Your Inhouse team will add "${s.n}" and test it first`)
          }
          return (
            <div key={suggestKey(s.n)} className="flex items-start gap-3.5 rounded-xl p-3">
              <IconTile icon={s.icon} iconSize={22} size="xl" tone="outline" />
              <div className="min-w-0 flex-1">
                <div className="text-md font-strong">{s.n}</div>
                <div className="text-sm text-pretty text-muted-foreground">{keepUnitsTogether(s.d)}</div>
              </div>
              <Button variant={req ? 'requested' : 'outline'} disabled={req} onClick={add} className="flex-none self-center">
                {req && <Icon name="check" size={17} />}{req ? 'Requested' : 'Request'}
              </Button>
            </div>
          )
        })}
      </CardGrid>
      </>}
    </Page>
  )
}

function SkillSheet({ skill: s, phone, onClose }: { skill: SkillDef; phone: boolean; onClose: () => void }) {
  const { S, agent: st } = useCtx()
  const locked = S < s.need
  const key = skillKey(s.n)
  const on = !locked && (!demo || st.toggles[key] !== false)
  // Closing gives focus back to the row that opened the sheet, as Window does.
  const before = useRef<HTMLElement | null>(null)
  // It opens with focus on the sheet itself, so Close shows no focus ring or tooltip until someone tabs to it.
  const panel = useRef<HTMLDivElement>(null)
  return (
    <Sheet open onOpenChange={o => { if (!o) onClose() }}>
      <SheetContent ref={panel} side={phone ? 'bottom' : 'right'} showCloseButton={false} aria-describedby={undefined}
        onPointerDownOutside={keepForToast} onInteractOutside={keepForToast}
        overlayProps={{ className: NO_MOTION }}
        onOpenAutoFocus={e => { before.current = claimTrigger(); e.preventDefault(); panel.current?.focus() }}
        // Unless something the sheet opened (the steps window) has taken focus already.
        onCloseAutoFocus={e => { e.preventDefault(); if (document.activeElement === document.body) restoreFocus(before.current) }}
        data-surface="window"
        className={cn('gap-0 overflow-hidden rounded-2xl border bg-window-surface shadow-menu', NO_MOTION, phone ? 'inset-2.5 h-auto w-auto' : 'inset-y-2.5 right-2.5 h-auto w-problem-panel sm:max-w-none')}>
        <div className="flex items-center gap-2 pt-3.5 pr-3.5 pl-6 text-xs text-muted-foreground">
          <Icon name={s.icon} size={16} />Skill
          <div className="flex-1" />
          <IconButton icon="close" label="Close" onClick={onClose} className={cn(phone && TAP)} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-6 pt-3 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle className="text-2xl leading-heading font-medium tracking-heading">{s.n}</SheetTitle>
            {locked && <StageTag tag={STAGE_TAGS[s.need]} />}
          </div>
          {demo && <div className="mt-5 flex items-center gap-4 rounded-xl border border-border bg-card px-4.5 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-md font-strong">{on ? 'On' : 'Off'}</div>
              <div className="text-sm text-foreground-3">{locked ? `Starts in ${STAGE_TAGS[s.need]}.` : on ? 'Your Inhouse agent uses this skill.' : "Your Inhouse agent won't use this skill."}</div>
            </div>
            <Switch on={on} label={`${s.n} on or off`} onChange={locked ? undefined : () => agent.setToggle(key, !on)} />
          </div>}
          <h3 className="mono-label mt-6">What it does</h3>
          <p className="mt-2 text-base leading-reading">{s.d}</p>
          <h3 className="mono-label mt-6">Where it's used</h3>
          <DetailList variant="ruled" className="mt-1 text-sm" items={skillFacts(demo !== null, s, n => STAGE_TAGS[n])} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
