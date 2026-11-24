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
  ] },
  { id: 'agent', label: 'Agent', team: true, pages: [
    { id: 'team-agent', icon: 'badge', label: 'Inhouse agent' },
    { id: 'team-modes', icon: 'auto_awesome', label: 'Models' },
    { id: 'team-memory', icon: 'bookmarks', label: 'Team memory' },
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
 * settings and their server checks stay), and every Notifications row is Act-stage work nothing sends yet, so it hides the
 * three pages, their menu entries and their deep links.
 */
const DEMO_ONLY_PAGES: readonly string[] = ['team-approvals', 'team-limits', 'you-notif']
/** Whether a page is offered: every page in the demo, all but the demo-only ones in the product. */
export const pageShown = (id: string, product: boolean): boolean => !(product && DEMO_ONLY_PAGES.includes(id))
/** The ids a `#/settings/<id>` link may name. */
export const settingsTabs = (product: boolean): string[] => SETTINGS_PAGES.filter(p => pageShown(p.id, product)).map(p => p.id)

/**
 * The menu as this brand sees it: Slack notices only with Slack connected, and in the product (`product`: the build has no
 * demo) no demo-only pages. What stays of the limits section is the Spending cap and Pause, so the product calls it "Spending".
 */
export const menuFor = (tools: SlackSignals, product = false): SettingsSection[] => {
  const slack = hasSlack(tools)
  if (slack && !product) return SECTIONS
  return SECTIONS.map(s => {
    const pages = s.pages.filter(p => (slack || p.id !== 'team-slack') && pageShown(p.id, product))
    return { ...s, pages, ...(product && s.id === 'limits' ? { label: 'Spending' } : {}) }
  })
}
