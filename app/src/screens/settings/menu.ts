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
    { id: 'you-notif', icon: 'notifications', label: 'Notifications' },
    { id: 'you-memory', icon: 'person_book', label: 'Memory' },
    { id: 'you-permissions', icon: 'task_alt', label: 'Always allowed' },
  ] },
  { id: 'agent', label: 'Agent', team: true, pages: [
    { id: 'team-agent', icon: 'badge', label: 'Inhouse agent' },
    { id: 'team-modes', icon: 'auto_awesome', label: 'Models' },
    { id: 'team-memory', icon: 'bookmarks', label: 'Team memory' },
    { id: 'team-ceiling', icon: 'tune', label: 'What the agent can do' },
  ] },
  { id: 'limits', label: 'Approvals and limits', team: true, pages: [
    { id: 'team-approvals', icon: 'task_alt', label: 'Who approves what' },
    { id: 'team-limits', icon: 'tune', label: 'Run limits' },
    { id: 'team-spend', icon: 'account_balance_wallet', label: 'Spending cap' },
  ] },
  { id: 'team', label: 'Team', team: true, pages: [
    { id: 'team-members', icon: 'group', label: 'Members' },
    { id: 'team-slack', icon: 'campaign', label: 'Slack notices' },
  ] },
  { id: 'workspace', label: 'Workspace', team: true, pages: [
    { id: 'team-plan', icon: 'stairs', label: 'Stage and plan' },
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
 * The pages only the demo offers. The product has no approval rules or run limits to show yet (the stored `a:<n>` and `l:*`
 * settings and their server checks stay), and every Notifications row is work nothing sends yet, so it hides those pages,
 * their menu entries and their deep links. Stage 1 M2-I: the product has no stages (decision "Master plan: one agent"), so
 * Stage and plan goes too; the technical `stage` setting stays, unread.
 */
const DEMO_ONLY_PAGES: readonly string[] = ['team-approvals', 'team-limits', 'you-notif', 'team-plan']
/**
 * Stage 1 M2-H: the pages only the product offers. The demo has no permissions, so Always allowed would always be empty.
 * Stage 1 M3-C: nor a ceiling, so What the agent can do would too.
 */
const PRODUCT_ONLY_PAGES: readonly string[] = ['you-permissions', 'team-ceiling']
/** Whether a page is offered: the demo leaves out the product-only pages, the product the demo-only ones. */
export const pageShown = (id: string, product: boolean): boolean => (product ? !DEMO_ONLY_PAGES.includes(id) : !PRODUCT_ONLY_PAGES.includes(id))
/** Where the account menu's Team settings opens: Stage and plan in the demo, the first team page in the product (M2-I). */
export const teamSettingsTab = (product: boolean): string => (product ? 'team-agent' : 'team-plan')
/** The ids a `#/settings/<id>` link may name. */
export const settingsTabs = (product: boolean): string[] => SETTINGS_PAGES.filter(p => pageShown(p.id, product)).map(p => p.id)

/** Stage 1 M2-H: the pages only a brand person has (the Inhouse team has no permissions: route 110 refuses them). */
const BRAND_PERSON_PAGES: readonly string[] = ['you-permissions']

/**
 * The menu as this brand sees it: Slack notices only with Slack connected, and in the product (`product`: the build has no
 * demo) no demo-only pages. What stays of the limits section is the Spending cap and Pause, so the product calls it "Spending".
 * `inhouse`: the viewer is the Inhouse team, who has no Always allowed page. `member`: the viewer is a member, who has
 * no What the agent can do page.
 */
export const menuFor = (tools: SlackSignals, product = false, inhouse = false, member = false): SettingsSection[] => {
  const slack = hasSlack(tools)
  return SECTIONS.map(s => {
    // Stage 1 M3-C: a member has no What the agent can do (route 150 lets only admins and the Inhouse team read it).
    const pages = s.pages.filter(p => (slack || p.id !== 'team-slack') && pageShown(p.id, product) && !(inhouse && BRAND_PERSON_PAGES.includes(p.id))
      && !(member && p.id === 'team-ceiling'))
    return { ...s, pages, ...(product && s.id === 'limits' ? { label: 'Spending' } : {}) }
  })
}
