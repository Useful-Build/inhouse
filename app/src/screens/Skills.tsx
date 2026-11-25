// Skills: the list, and each skill's own page (#/skills/<name>).
import { agent, demo } from '../agent'
import { keepUnitsTogether } from '../agent/clock'
import { STAGE_TAGS, whenOf } from '../state/derive'
import { display } from '../state/display'
import { fmtDay } from '../lib/format'
import { skillBySlug, skillSlugs, useCtx, useUi } from '../state/store'
import type { SkillTab } from '../state/store'
import type { SkillDef } from '../agent'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { Button, CardGrid, EmptyState, Icon, IconButton, IconTile, LogoTile, MenuItem, Page, PageHeader, SectionHeader, Segmented, StageTag } from '../ui'
import { Confirm, SearchBox, TAP } from '../ui/fields'
import { rememberTrigger, triggerTogglesMenu } from '../ui/dialogs'
import { Markdown } from './chat/markdown'

const SECTION_HEAD = 'mb-1.5'
const TABS: [SkillTab, string][] = [['all', 'All'], ['team', 'By Inhouse team'], ['mine', 'By your team']]
/** What a new chat starts with to make a skill: the agent's Skill Creator takes it from there. */
export const CREATE_SKILL_PROMPT = 'Create a skill that '
/** What a brand skill's "Edit in a chat" starts with. */
export const editSkillPrompt = (name: string) => `Change the "${name}" skill: `
/** Who made a brand skill, as its row and page say it ("Made by Sam Mercer"). */
export const madeBy = (s: SkillDef) => `Made by ${s.by.replace(/, in a chat$/, '')}`
/** Where a skill's on switch is saved in `AgentState.toggles`. Missing means on. */
const skillKey = (name: string) => `s:${name}`

export function Skills() {
  const { S, agent: st, data } = useCtx()
  const loading = data.status === 'loading'
  const tab = useUi(s => s.skillTab)
  const patch = useUi(s => s.patch)
  const newChat = useUi(s => s.newChat)
  const openTeam = useUi(s => s.openTeam)
  const showToast = useUi(s => s.showToast)
  const phone = useUi(s => s.phone)
  const openSkill = useUi(s => s.openSkill)

  /** Name plus how many times it came before in the same list: unique, and steady while nothing is added in front. */
  const keyer = () => { const seen = new Map<string, number>(); return (name: string) => { const n = seen.get(name) ?? 0; seen.set(name, n + 1); return `${name}|${n}` } }
  const listKey = keyer()
  const suggestKey = keyer()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const hit = (name: string, desc: string) => !needle || `${name} ${desc}`.toLowerCase().includes(needle)
  const slugs = skillSlugs(data, st)
  const list = st.skillsExtra.concat(data.skills).filter(s => (tab === 'all' || (tab === 'mine' ? s.mine : !s.mine)) && hit(s.n, s.d))
  const suggestions = data.skillSuggestions.filter(s => hit(s.n, s.d))

  return (
    <Page>
      <PageHeader title="Skills" description="Instructions that teach your Inhouse agent a job. Make your own in a chat, or use the ones your Inhouse team writes."
        actions={<Segmented label="Show skills" value={tab} options={TABS} onChange={v => patch({ skillTab: v })} className={cn(phone && '*:min-h-11')} />} />
      <div className="mt-5.5 flex gap-2.5">
        <SearchBox value={query} onChange={setQuery} placeholder="Search skills" label="Search skills" />
        {/* The agent's Skill Creator makes it with the person in a new chat, and saves it for the whole team. */}
        <Button size="lg" onClick={() => newChat(CREATE_SKILL_PROMPT)}><Icon name="add" size={18} />Create a skill</Button>
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
                  {/* The name opens the skill's page; its tap area covers the whole row. */}
                  <button type="button" onClick={() => openSkill(slugs.get(s)!)} className="min-w-0 text-left after:absolute after:inset-0 after:rounded-xl">{s.n}</button>
                  {locked && <StageTag tag={STAGE_TAGS[s.need]} />}
                  {off && <Badge variant="muted">Off</Badge>}
                </div>
                <div className="text-sm text-pretty text-muted-foreground">{keepUnitsTogether(s.d)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{[s.mine ? madeBy(s) : s.by, s.used].filter(Boolean).join(' · ')}</div>
              </div>
            </div>
          )
        })}
      </CardGrid>
      {/* A skill the team can't make in a chat (a new tool, a bigger job) is a request to the Inhouse team. */}
      <p className="mt-3 px-3 text-sm text-muted-foreground">
        Need one your team can't make in a chat?{' '}
        <Button variant="link" className="h-auto p-0 align-baseline text-sm" onClick={() => openTeam('job')}>Request a skill</Button>
      </p>
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


/** Who made it, and who changed it last: "By the Inhouse team. Priya Shah changed it on Nov 20." */
export function byline(s: SkillDef): string {
  const made = s.mine ? `${madeBy(s)} in a chat.` : `By the ${s.by}.`
  return s.updatedAt ? `${made} Changed on ${fmtDay(s.updatedAt, display())}.` : made
}

/** The side rail's key-value rows for a skill's page. */
export function skillFacts(s: SkillDef, isDemo: boolean): [string, string][] {
  // On the product "Works from" is dropped at need 0 (every skill starts at Watch), and "Used" shows only when there is one.
  const facts: [string, string][] = isDemo || s.need > 0 ? [['Works from', STAGE_TAGS[s.need]]] : []
  const maker = s.by.replace(/, in a chat$/, '')
  facts.push(['Made by', s.mine ? maker : s.by])
  // A brand skill: its maker and admins change it in a chat, or admins only once the maker's data is deleted. The Inhouse team's: only the Inhouse team.
  facts.push(['Who can change it', s.mine ? (maker === 'a former member' ? 'Admins' : `${maker} and admins`) : 'Inhouse team'])
  if (s.used) facts.push(['Used', s.used])
  return facts
}

/** A card in the page's side rail, titled when it has a title. */
function RailCard({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('w-full rounded-2xl border border-border bg-card px-5 shadow-card', title ? 'py-4.5' : 'py-1.5', className)}>
      {title && <h2 className="text-sm font-semibold">{title}</h2>}
      {children}
    </section>
  )
}

/** A skill's page: what it's for, a way to try it, its instructions and the facts beside them. */
export function SkillPage() {
  const { S, agent: st, data } = useCtx()
  const key = useUi(s => s.skillKey)
  const go = useUi(s => s.go)
  const newChat = useUi(s => s.newChat)
  const ask = useUi(s => s.ask)
  const showToast = useUi(s => s.showToast)
  const phone = useUi(s => s.phone)
  const s = skillBySlug(data, st, key)
  // Deleting a brand skill asks first, in the page's own window (never the browser's confirm()).
  const [deleting, setDeleting] = useState(false)
  // The instructions come separately (the demo's are their own chunk): ask for them once the page knows its skill.
  const want = s && s.body === undefined ? s.n : null
  useEffect(() => {
    if (want) agent.loadSkill(want).catch((err: unknown) => { console.warn(`Inhouse: could not load the instructions for ${want}.`, err) })
  }, [want])
  // App shows the list in place of a skill it doesn't know (and moves the route there once the skills have loaded).
  if (!s) return null
  const locked = S < s.need
  const toggle = skillKey(s.n)
  // The product has no skill switch: every skill is on.
  const on = !locked && (demo === null || st.toggles[toggle] !== false)
  const example = s.example && !locked ? `Use the "${s.n}" skill: ${s.example}` : null
  const toolsOf = (s.tools ?? []).map(k => ({ k, name: data.tools.details[k]?.name ?? data.tools.catalog.find(c => c.k === k)?.name ?? k }))
  const usedBy = (s.routines ?? []).flatMap(id => data.routines.filter(r => r.id === id && !st.routinesDeleted[r.id] && !(r.inChat && S < r.need)))
  const facts = skillFacts(s, demo !== null)
  const canChange = !!s.mine && s.canChange === true
  // The switch is the demo's; the product has none. Delete is for a brand skill its maker or an admin may change.
  const switchable = demo !== null
  const remove = () => {
    const name = s.n
    setDeleting(false)
    agent.deleteSkill(name).then(
      () => { go('skills'); showToast(`Deleted "${name}". Your Inhouse agent stops using it from the next chat.`, { icon: 'delete' }) },
      // The client has told the person why (a notice); the skill stays on its page.
      (err: unknown) => console.warn(`Inhouse: could not delete ${name}.`, err instanceof Error ? err.message : err),
    )
  }
  const switchIt = () => {
    agent.setToggle(toggle, !on)
    showToast(on ? `${s.n} is off. Your Inhouse agent won't use it.` : `${s.n} is on again`, { icon: on ? 'pause' : 'play_arrow', ms: 4000 })
  }

  return (
    <Page width="detail" className="pt-4.5">
      <Button variant="quiet" onClick={() => go('skills')} className="gap-1">
        <Icon name="arrow_back" size={17} />Skills
      </Button>
      <PageHeader className="mt-4 items-start" title={s.n}
        leading={(
          <span aria-hidden="true" className={cn('flex size-16 flex-none items-center justify-center rounded-2xl border border-border bg-card shadow-card', locked ? 'text-foreground-3' : 'text-brand')}>
            <Icon name={s.icon} size={30} />
          </span>
        )}
        tag={(
          <span className="flex items-center gap-2">
            {locked ? <StageTag tag={STAGE_TAGS[s.need]} size="lg" /> : <Badge variant="outline" size="md">{STAGE_TAGS[s.need]}</Badge>}
            {!locked && !on && <Badge variant="muted" size="md">Off</Badge>}
          </span>
        )}
        description={<>
          <span className="block text-lg leading-prose">{keepUnitsTogether(s.d)}</span>
          <span className="mt-2.5 block text-sm text-muted-foreground">{byline(s)}</span>
        </>}
        actions={!locked && <>
          {canChange && (
            <Button variant="outline" size="lg" onClick={() => newChat(editSkillPrompt(s.n))}>
              <Icon name="edit" size={17} />Edit in a chat
            </Button>
          )}
          <Button size="lg" onClick={() => newChat(`Use the "${s.n}" skill: `)}>
            <Icon name="chat_bubble" size={17} />Try in a chat
          </Button>
          {(switchable || canChange) && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton data-skill-more icon="more_horiz" label={`More for ${s.n}`} size={18} box="icon-lg" className={cn(phone && TAP)} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" collisionPadding={16} aria-label="Skill actions" aria-labelledby={undefined} className="w-menu-message max-w-screen-gutter border-input"
                // More reopens the menu even while it's still fading out (after Delete skill, then Cancel).
                onInteractOutside={triggerTogglesMenu('[data-skill-more]')}>
                {switchable && (
                  <MenuItem onSelect={switchIt}>
                    <Icon name={on ? 'pause_circle' : 'play_circle'} size={18} />{on ? 'Turn off' : 'Turn on'}
                  </MenuItem>
                )}
                {canChange && (
                  // Cancel gives focus back to the More button, never to this item (gone with the menu).
                  <MenuItem variant="destructive" onSelect={() => { rememberTrigger(document.querySelector<HTMLElement>('[data-skill-more]')); setDeleting(true) }}>
                    <Icon name="delete" size={18} />Delete skill
                  </MenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>} />

      {example && s.example && (
        <div className="mt-7 rounded-3xl border border-border bg-draft-sheet px-4 py-4 sm:px-14 sm:py-7">
          <button type="button" data-skill-try onClick={() => { void ask(example) }} aria-label={`Ask: ${example}`}
            className="mx-auto flex w-full max-w-180 items-center gap-2.5 rounded-2xl bg-card py-2.5 pr-2.5 pl-3 text-left shadow-float transition-colors hover:bg-accent">
            <span className="inline-flex h-7.5 max-w-1/2 flex-none items-center gap-1.5 rounded-lg bg-brand-tint px-2.5 text-sm font-strong text-brand-text">
              <Icon name={s.icon} size={16} /><span className="ellipsis">{s.n}</span>
            </span>
            <span className="ellipsis min-w-0 flex-1 text-md text-foreground-2">{s.example}</span>
            <span aria-hidden="true" className="flex size-8.5 flex-none items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Icon name="arrow_upward" size={18} />
            </span>
          </button>
        </div>
      )}

      <div className="@container mt-7">
        {/* The label sits above the whole row, so the instructions card and the side cards start on one line. */}
        {s.body && <div id="skill-instructions" className="px-1 pb-3 text-base font-medium text-foreground-3">Instructions</div>}
        <div className="flex flex-col gap-6 @4xl:flex-row @4xl:items-start">
          {s.body && (
            <div className="min-w-0 flex-1">
              <article aria-labelledby="skill-instructions" className="rounded-3xl border border-border bg-card px-5 pt-8 pb-9 shadow-card sm:px-10 sm:pt-10 sm:pb-11">
                <Markdown text={s.body} look="page" />
              </article>
            </div>
          )}
          {/* Stacked under the instructions, the rail's cards sit two to a row (one on a phone). */}
          <aside aria-label="About this skill" className={cn('grid gap-4 @xl:grid-cols-2', s.body && '@4xl:flex @4xl:w-detail-rail @4xl:flex-none @4xl:flex-col')}>
            <RailCard>
              <dl>
                {facts.map(([k, v], i) => (
                  <div key={k} className={cn('flex justify-between gap-3 py-3.25 text-sm', i > 0 && 'border-t border-divider')}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="text-right font-medium">{v}</dd>
                  </div>
                ))}
              </dl>
            </RailCard>
            {toolsOf.length > 0 && (
              <RailCard title="Tools it reads">
                <ul className="mt-3 flex flex-col gap-2.5 text-base">
                  {toolsOf.map(t => <li key={t.k} className="flex items-center gap-2.5"><LogoTile k={t.k} size="sm" round />{t.name}</li>)}
                </ul>
              </RailCard>
            )}
            {usedBy.length > 0 && (
              <RailCard title="Used by">
                <ul className="mt-2 -mx-2 flex flex-col">
                  {usedBy.map(r => (
                    <li key={r.id}>
                      <button type="button" onClick={() => go('routines')} className="flex w-full items-center gap-2.5 rounded-xl p-2 text-left transition-colors hover:bg-accent">
                        <IconTile icon="event_repeat" iconSize={18} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-base font-medium">{r.name}</span>
                          <span className="block text-xs text-muted-foreground">{['Routine', whenOf(r)].filter(Boolean).join(' · ')}</span>
                        </span>
                        <Icon name="chevron_right" size={18} className="text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              </RailCard>
            )}
          </aside>
        </div>
      </div>
      {deleting && (
        <Confirm label="Delete skill" title={`Delete "${s.n}"?`} action="Delete skill" onCancel={() => setDeleting(false)} onConfirm={remove}>
          Your Inhouse agent stops using it for everyone on the team, from the next chat. This can't be undone.
        </Confirm>
      )}
    </Page>
  )
}
