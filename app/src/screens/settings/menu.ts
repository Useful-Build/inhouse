// The Settings menu: its groups and pages. Its own file so the app shell and the command palette take the list without
// pulling in every page's content (content.ts loads with the Settings screen).
export const MENU: { label: string; items: [string, string, string][] }[] = [
  { label: 'Your settings', items: [['you-general', 'person', 'General'], ['you-notif', 'notifications', 'Notifications'], ['you-memory', 'neurology', 'Memory']] },
  { label: 'Team settings · admins', items: [['team-plan', 'stairs', 'Stage and plan'], ['team-agent', 'badge', 'Inhouse agent'], ['team-modes', 'psychology', 'Models'], ['team-memory', 'neurology', 'Team memory'], ['team-members', 'group', 'Members'], ['team-approvals', 'task_alt', 'Who approves what'], ['team-slack', 'campaign', 'Slack notices'], ['team-limits', 'tune', 'Run limits'], ['team-spend', 'savings', 'Spending cap'], ['team-data', 'shield_lock', 'Data and access'], ['team-audit', 'history_edu', 'Audit log']] },
]
