// The team, for the real targets: what the seed made, and how a test is put back to it. There is no reseeding here:
// `wrangler dev` holds the local D1 open, and a second writer on one SQLite file isn't safe. So the reset walks the
// API as the seed's Admin and undoes what the cases did (an invitation left open, a role changed, a person removed),
// each case still reads the current state first and invites its own person. The audit log is append-only and keeps
// every line; nothing here depends on its length.
import { SEED, SEED_INVITE, allMembers, whoAmI } from './me'
import type { Seeded, Signer } from './me'

const SEEDED = ['admin', 'dana', 'leo'] as const satisfies readonly Seeded[]

/** Who the seed made and what they are: Sam the only Admin, Dana and Leo Members, Priya invited and unbound. */
export async function resetTeam(s: Signer): Promise<void> {
  const settle = async (r: Promise<{ status: number; json: unknown }>, what: string) => {
    const { status, json } = await r
    if (status >= 300) throw new Error(`The reset of the real contract target failed at ${what}: ${status} ${JSON.stringify(json)}`)
  }
  // Someone who is an Admin right now: the one who can put the rest back (there is always one: the last Admin can't go).
  const actor = async (): Promise<Seeded> => {
    for (const who of SEEDED) if ((await whoAmI(s, who))?.role === 'admin') return who
    throw new Error('The real contract target found no seeded Admin to reset the team with.')
  }
  const wanted: Record<string, { who: Seeded | 'invite'; email: string; name: string; title: string; role: 'member' | 'admin' }> = {
    [SEED.admin.email]: { who: 'admin', ...SEED.admin }, [SEED.dana.email]: { who: 'dana', ...SEED.dana }, [SEED.leo.email]: { who: 'leo', ...SEED.leo },
    [SEED_INVITE.email]: { who: 'invite', ...SEED_INVITE },
  }
  let by = await actor()
  // 1. Anyone the cases invited who is still open goes (removed rows stay; inviting them again brings the row back).
  for (const m of await allMembers(s, by)) {
    if (m.email && wanted[m.email] === undefined && m.status !== 'removed') await settle(s.api(by, 'DELETE', `/api/members/${m.id}?ifRev=${m.rev}`), `removing ${m.id}`)
  }
  // 2. Seeded people who were removed are invited again; signing in brings a person back (the invite's role is the seed's).
  for (const m of await allMembers(s, by)) {
    const w = m.email ? wanted[m.email] : undefined
    if (!w || m.status !== 'removed') continue
    await settle(s.api(by, 'POST', '/api/members/invites', { name: w.name, email: w.email, title: w.title, role: w.role }), `inviting ${w.email} again`)
    if (w.who !== 'invite') await whoAmI(s, w.who)
  }
  // 3. Roles: promotions first (so there is always an Admin), then demotions, by someone who is an Admin now.
  const roles = async (pick: 'member' | 'admin') => {
    for (const m of await allMembers(s, by)) {
      const w = m.email ? wanted[m.email] : undefined
      if (w && m.status !== 'removed' && w.role === pick && m.role !== pick) await settle(s.api(by, 'PUT', `/api/members/${m.id}/role`, { role: pick, ifRev: m.rev }), `setting ${w.email} to ${pick}`)
    }
  }
  await roles('admin')
  by = await actor()
  if ((await whoAmI(s, 'admin'))?.role === 'admin') by = 'admin'
  await roles('member')
}
