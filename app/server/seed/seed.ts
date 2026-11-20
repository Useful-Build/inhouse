// Writes the invented brand (brand.ts) through the data layer, so every row comes with its audit line, as a request
// would write it: the first Admin's invite (by the system row), sign-ins that bind, the Admin's invites, an Inhouse
// first sign-in and settings. Refuses a database that already has people (it never seeds twice).
import { settingSpec } from '../../shared/contract/settings.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import type { At } from '../db/members.ts'
import { BRAND_OWNER } from '../db/settings.ts'
import type { Stores } from '../db/stores.ts'
import { SEED_INHOUSE, SEED_INVITE, SEED_PEOPLE, SEED_SETTINGS } from './brand.ts'

export interface Seeded {
  members: Record<keyof typeof SEED_PEOPLE | 'invite' | 'inhouse' | 'smoke', string>
}

export async function seedBrand(db: D1Database, stores: Stores, nowMs: number): Promise<Seeded> {
  const people = await db.prepare("SELECT COUNT(*) AS n FROM members WHERE kind = 'person'").first<number>('n')
  if (people !== 0) throw new Error('seed: this database already has people (seeded before, or a seed that failed part way)')
  let tick = 0
  const at = (actorId: string): At => ({ actorId, requestId: `seed-${crypto.randomUUID()}`, nowMs: nowMs + tick++ * 60_000 })
  const signIn = async (p: { subject: string; email: string }) => {
    const r = await stores.members.resolvePerson({ subject: p.subject, email: p.email, requestId: `seed-${crypto.randomUUID()}`, nowMs: nowMs + tick++ * 60_000 })
    if (!('ok' in r)) throw new Error(`seed: sign-in refused (${r.refused})`)
    return r.ok.memberId
  }
  const invite = async (by: string, p: { email: string; name: string; title: string; role: 'member' | 'admin' }) => {
    const r = await stores.members.invite({ name: p.name, email: p.email, title: p.title, role: p.role }, at(by))
    if (!('ok' in r)) throw new Error(`seed: invite refused (${r.refused})`)
    return r.ok.id
  }

  await invite(SYSTEM_MEMBER_ID, SEED_PEOPLE.admin)
  const admin = await signIn(SEED_PEOPLE.admin)
  await invite(admin, SEED_PEOPLE.dana)
  await invite(admin, SEED_PEOPLE.leo)
  const invited = await invite(admin, SEED_INVITE)
  const dana = await signIn(SEED_PEOPLE.dana)
  const leo = await signIn(SEED_PEOPLE.leo)
  const inhouse = (await stores.members.resolveInhouse({ ...SEED_INHOUSE, requestId: `seed-${crypto.randomUUID()}`, nowMs: nowMs + tick++ * 60_000 })).memberId
  const ids = { admin, dana, inhouse }

  for (const [scope, key, value, who] of SEED_SETTINGS) {
    const spec = settingSpec(key)
    if (!spec || spec.scope !== scope) throw new Error(`seed: ${key} is not a ${scope} setting`)
    const actor = ids[who]
    const r = await stores.settings.write({ owner: scope === 'personal' ? actor : BRAND_OWNER, scope, key, value: spec.value.parse(value), ifRev: 0 }, at(actor))
    if (!('ok' in r)) throw new Error(`seed: ${key} not written`)
  }
  return { members: { admin, dana, leo, invite: invited, inhouse, smoke: await stores.members.serviceMember('smoke') } }
}
