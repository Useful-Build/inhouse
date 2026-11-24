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

/** The menu as this brand sees it: Slack notices only with Slack connected. */
export const menuFor = (tools: SlackSignals): SettingsSection[] =>
  hasSlack(tools) ? SECTIONS : SECTIONS.map(s => (s.id === 'team' ? { ...s, pages: s.pages.filter(p => p.id !== 'team-slack') } : s))
