// The Settings menu: its sections and pages. Its own file so the app shell and the command palette take the list without
// pulling in every page's content (content.ts loads with the Settings screen). The menu, its search, the command palette
// and the routes all read this one list.

export interface SettingsPage {
  /** The page's stable id: its route (`#/settings/<id>`) and the key its content is found by. */
  id: string
  icon: string
  label: string
}

export interface SettingsSection {
  /** Stable, so a section can be found and labelled whatever its heading says. */
  id: 'you' | 'agent' | 'limits' | 'team' | 'workspace'
  label: string
  /** A team section: brand settings only an Admin changes (`editBrandSettings`). Its heading shows a lock for anyone else. */
  team: boolean
  pages: SettingsPage[]
}

export const SECTIONS: SettingsSection[] = [
  { id: 'you', label: 'You', team: false, pages: [
    { id: 'you-general', icon: 'person', label: 'General' },
    { id: 'you-memory', icon: 'person_book', label: 'Memory' },
    { id: 'you-permissions', icon: 'task_alt', label: 'Always allowed' },
  ] },
  { id: 'agent', label: 'Agent', team: true, pages: [
    { id: 'team-agent', icon: 'badge', label: 'Inhouse agent' },
    { id: 'team-modes', icon: 'auto_awesome', label: 'Models' },
    { id: 'team-memory', icon: 'bookmarks', label: 'Team memory' },
    { id: 'team-ceiling', icon: 'tune', label: 'What the agent can do' },
  ] },
  { id: 'limits', label: 'Spending', team: true, pages: [
    { id: 'team-spend', icon: 'account_balance_wallet', label: 'Spending cap' },
  ] },
  { id: 'team', label: 'Team', team: true, pages: [
    { id: 'team-members', icon: 'group', label: 'Members' },
    { id: 'team-slack', icon: 'campaign', label: 'Slack notices' },
  ] },
  { id: 'workspace', label: 'Workspace', team: true, pages: [
    { id: 'team-data', icon: 'shield_lock', label: 'Data and access' },
    { id: 'team-audit', icon: 'receipt_long', label: 'Audit log' },
  ] },
]

/** Every settings page, in menu order. */
export const SETTINGS_PAGES: SettingsPage[] = SECTIONS.flatMap(s => s.pages)

/** The tools data the menu reads: the tools the agent reads and the channels it talks on. */
type SlackSignals = { connected: readonly string[]; channels: readonly { key: string }[] }

/** P5 W4: whether the brand has Slack connected (a tool it reads, or its chat channel). Slack notices shows only then. */
export const hasSlack = (tools: SlackSignals): boolean => tools.connected.includes('slack') || tools.channels.some(c => c.key === 'slack')

/**
 * The pages only the product offers: none. The demo has no pages of its own and leaves none out: since decision A13
 * (option B) it shows what the product does, so Who approves what, Run limits, Notifications and Stage and plan are gone
 * from both (the stored `a:<n>`, `l:*` and `stage` settings stay, unread by any page), and since the demo catch-up's PR 3
 * What the agent can do is in both (read-only, as in a deployable build).
 */
const PRODUCT_ONLY_PAGES: readonly string[] = []
/** Whether a page is offered: the demo leaves out the product-only pages. */
export const pageShown = (id: string, product: boolean): boolean => product || !PRODUCT_ONLY_PAGES.includes(id)
/** Where the account menu's Team settings opens: the first team page (M2-I). */
export const TEAM_SETTINGS_TAB = 'team-agent'
/** The ids a `#/settings/<id>` link may name. */
export const settingsTabs = (product: boolean): string[] => SETTINGS_PAGES.filter(p => pageShown(p.id, product)).map(p => p.id)

/** Stage 1 M2-H: the pages only a brand person has (the Inhouse team has no permissions: route 110 refuses them). */
const BRAND_PERSON_PAGES: readonly string[] = ['you-permissions']

/**
 * The menu as this brand sees it: Slack notices only with Slack connected, and in the demo (`product` false) no
 * product-only pages (there are none now).
 * `role`: the viewer's (unknown while signing in): the Inhouse team has no Always allowed page, and (Stage 1 M3-C) a member
 * no What the agent can do (route 150 lets only admins and the Inhouse team read it).
 */
export const menuFor = (tools: SlackSignals, product = false, role?: string | null): SettingsSection[] => {
  const slack = hasSlack(tools)
  return SECTIONS.map(s => {
    const pages = s.pages.filter(p => (slack || p.id !== 'team-slack') && pageShown(p.id, product) && !(role === 'inhouse' && BRAND_PERSON_PAGES.includes(p.id))
      && !(role === 'member' && p.id === 'team-ceiling'))
    return { ...s, pages }
  })
}
