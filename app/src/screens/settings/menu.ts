// The Settings menu: its groups and pages. Its own file so the app shell and the command palette take the list without
// pulling in every page's content (content.ts loads with the Settings screen).
export const MENU: { label: string; items: [string, string, string][] }[] = [
  { label: 'Your settings', items: [['you-general', 'person', 'General'], ['you-notif', 'notifications', 'Notifications'], ['you-memory', 'neurology', 'Memory']] },
  { label: 'Team settings · admins', items: [['team-plan', 'stairs', 'Stage and plan'], ['team-agent', 'badge', 'Inhouse agent'], ['team-modes', 'psychology', 'Models'], ['team-memory', 'neurology', 'Team memory'], ['team-members', 'group', 'Members'], ['team-approvals', 'task_alt', 'Who approves what'], ['team-slack', 'campaign', 'Slack notices'], ['team-limits', 'tune', 'Run limits'], ['team-spend', 'savings', 'Spending cap'], ['team-data', 'shield_lock', 'Data and access'], ['team-audit', 'history_edu', 'Audit log']] },
]

/** The tools data the menu reads: the tools the agent reads and the channels it talks on. */
type SlackSignals = { connected: readonly string[]; channels: readonly { key: string }[] }

/** P5 W4: whether the brand has Slack connected (a tool it reads, or its chat channel). Slack notices shows only then. */
export const hasSlack = (tools: SlackSignals): boolean => tools.connected.includes('slack') || tools.channels.some(c => c.key === 'slack')

/** The menu as this brand sees it: Slack notices only with Slack connected. */
export const menuFor = (tools: SlackSignals): typeof MENU =>
  hasSlack(tools) ? MENU : MENU.map(g => ({ ...g, items: g.items.filter(([k]) => k !== 'team-slack') }))
