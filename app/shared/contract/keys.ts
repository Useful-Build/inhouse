// Closed lists the client code needs as plain values. This file has NO imports, so a client that only wants a list (the
// mock, the HTTP client) doesn't pull zod's runtime into its bundle; the schemas in common.ts, me.ts and grants.ts are
// built from these lists, so each list is defined once.

/** One per list in `AgentData` (C3). `members` and `audit` also page. */
export const RESOURCE_KEYS = [
  'meta', 'problems', 'tools', 'routines', 'skills', 'usage', 'members', 'rules', 'grants', 'memory', 'audit', 'activity', 'notifications',
  'models', 'chat', 'library',
] as const

/** The actions the UI asks `me().can` about, each tied to one access-matrix row (p2-design.md section 3). */
export const CAN_KEYS = [
  'invite', 'changeRole', 'remove', 'editBrandSettings', 'editTechnical', 'switchModel', 'grantSupport',
  'viewMembers', 'viewAudit', 'exportAudit',
] as const

/** How long a support grant may run, in hours. */
export const GRANT_HOURS = [1, 4, 24, 72] as const
