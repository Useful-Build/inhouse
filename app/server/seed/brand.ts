// The invented brand the test build is seeded with (p2-design section 10). Invented names, `example.test` emails and
// made-up Access subjects only. W1's mint helper signs these subjects and emails in; nothing here is a secret.

export interface SeedPerson {
  /** The Access `sub` the test issuer mints for this person. */
  subject: string
  email: string
  name: string
  title: string
  role: 'member' | 'admin'
}

/** People who have signed in: an Admin and two Members (Dana has personal settings). */
export const SEED_PEOPLE = {
  admin: { subject: 'seed-subject-sam', email: 'sam@example.test', name: 'Sam Mercer', title: 'Head of Ops', role: 'admin' },
  dana: { subject: 'seed-subject-dana', email: 'dana@example.test', name: 'Dana Kim', title: 'Finance', role: 'member' },
  leo: { subject: 'seed-subject-leo', email: 'leo@example.test', name: 'Leo Park', title: 'Customer service', role: 'member' },
} as const satisfies Record<string, SeedPerson>

/** An invite nobody has accepted yet (no subject: signing in with this email binds it). */
export const SEED_INVITE = { email: 'priya@example.test', name: 'Priya Shah', title: 'Marketing', role: 'member' } as const

/** An Inhouse team member (signs in on the Inhouse app; the row is made at the first sign-in). */
export const SEED_INHOUSE = { subject: 'seed-subject-alex', email: 'alex@inhouse.example.test' } as const

/** The settings the seed writes: [scope, key, value, who writes it]. */
export const SEED_SETTINGS = [
  ['brand', 'b:name', 'Northline Outdoor', 'admin'],
  ['brand', 'g:tz', 'America/New_York', 'admin'],
  ['brand', 's:cap', '$320', 'admin'],
  ['brand', 's:currency', 'USD ($)', 'admin'],
  ['technical', 'stage', 'Watch', 'inhouse'],
  ['technical', 'tm:fable:effort', 'High', 'inhouse'],
  // WebFetch reaches only listed hosts (P8a S): the test build's WebFetch scenario reads example.com (IANA's example domain).
  ['technical', 't:webfetch', 'example.com', 'inhouse'],
  ['personal', 'g:theme', 'Dark', 'dana'],
  ['personal', 'n:weekly', true, 'dana'],
] as const
