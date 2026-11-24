// Closed lists the client code needs as plain values. This file has NO imports, so a client that only wants a list (the
// mock, the HTTP client) doesn't pull zod's runtime into its bundle; the schemas in common.ts, me.ts and grants.ts are
// built from these lists, so each list is defined once.

/** One per list in `AgentData` (C3). `members` and `audit` also page. */
export const RESOURCE_KEYS = [
  'meta', 'problems', 'tools', 'routines', 'skills', 'usage', 'members', 'rules', 'grants', 'memory', 'audit', 'activity', 'notifications', 'requests',
  'models', 'chat', 'library',
] as const

/** The actions the UI asks `me().can` about, each tied to one access-matrix row (p2-design.md section 3). */
export const CAN_KEYS = [
  'invite', 'changeRole', 'remove', 'editBrandSettings', 'editTechnical', 'switchModel', 'grantSupport',
  'viewMembers', 'viewAudit', 'exportAudit', 'approveMemory', 'exportData',
] as const

/** How long a support grant may run, in hours. */
export const GRANT_HOURS = [1, 4, 24, 72] as const

/** The longest request to the Inhouse team, in characters (the server's bound; the team window's counter). */
export const TEAM_REQUEST_TEXT_MAX = 1000

/** The most live (not deleted) team routines a brand may have (#312 review M2). System routines don't count. */
export const MAX_TEAM_ROUTINES = 50

/** The most runs route 86 answers for one routine (master plan decision 8). */
export const ROUTINE_RUNS_MAX = 20

/** How a routine's run went, in the panel's closed list (route 86). */
export const ROUTINE_RUN_OUTCOMES = ['running', 'done', 'failed', 'skipped'] as const
