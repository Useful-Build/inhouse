// Settings, for the real targets: the seeded Admin's own and the brand's, as the suite's fixtures name them. The keys are
// ones the Admin may write (a personal key, the brand's time zone); the technical scope is the Inhouse team's.
import type { Fixtures } from '../../targets'
import { SEED_SETTINGS } from '../../../../../server/seed/brand'
import type { Signer } from './me'

/** One text setting, one switch, a second text setting, and a key with three values. All personal but the last (brand). */
export const settingFixtures = {
  toggleKey: 'n:weekly',
  settingKey: 'n:channel',
  settingValue: 'ops-alerts',
  otherSetting: { key: 'g:lang', value: 'Français' },
  choices: { key: 'g:tz', values: ['Europe/London', 'America/Chicago', 'Australia/Sydney'] as [string, string, string] },
} satisfies Pick<Fixtures, 'toggleKey' | 'settingKey' | 'settingValue' | 'otherSetting' | 'choices'>

/**
 * Puts what the cases write back: the seeded Admin's personal settings to unset (the name is the member's own and stays),
 * and the brand keys the fixtures use to the seed's value (unset when the seed has none). A case that saved one would
 * otherwise start the next with it. Other brand keys aren't written by any case, so they aren't touched.
 */
export async function resetSettings(s: Signer): Promise<void> {
  const put = async (scope: string, key: string, value: unknown, rev: number) => {
    const done = await s.api('admin', 'PUT', `/api/settings/${scope}/${encodeURIComponent(key)}`, { value, ifRev: rev })
    if (done.status >= 300) throw new Error(`The real contract target couldn't put ${key} back: ${done.status}`)
  }
  const list = async (scope: string) => {
    const r = await s.api('admin', 'GET', `/api/settings/${scope}`)
    if (r.status !== 200) throw new Error(`The real contract target couldn't read the ${scope} settings: ${r.status}`)
    return r.json.items as { key: string; value: unknown; rev: number }[]
  }
  for (const rec of await list('personal')) {
    if (rec.value !== null && rec.key !== 'g:name') await put('personal', rec.key, null, rec.rev)
  }
  const seeded = (key: string) => SEED_SETTINGS.find(([scope, k]) => scope === 'brand' && k === key)?.[2] ?? null
  for (const rec of await list('brand')) {
    if (rec.key === settingFixtures.choices.key && rec.value !== seeded(rec.key)) await put('brand', rec.key, seeded(rec.key), rec.rev)
  }
}
