// Settings, for the real targets: the seeded Admin's own and the brand's, as the suite's fixtures name them. The keys are
// ones the Admin may write (a personal key, the brand's time zone); the technical scope is the Inhouse team's.
import type { Fixtures } from '../../targets'
import type { Signer } from './me'

/** One text setting, one switch, a second text setting, and a key with three values. All personal but the last (brand). */
export const settingFixtures = {
  toggleKey: 'n:weekly',
  settingKey: 'n:channel',
  settingValue: 'ops-alerts',
  otherSetting: { key: 'g:lang', value: 'Français' },
  choices: { key: 'g:tz', values: ['Europe/London', 'America/Chicago', 'Australia/Sydney'] as [string, string, string] },
} satisfies Pick<Fixtures, 'toggleKey' | 'settingKey' | 'settingValue' | 'otherSetting' | 'choices'>

/** Puts the seeded Admin's personal settings back to unset (a case that saved one would otherwise start the next with it). The name is the member's own and stays. */
export async function resetPersonalSettings(s: Signer): Promise<void> {
  const r = await s.api('admin', 'GET', '/api/settings/personal')
  if (r.status !== 200) throw new Error(`The real contract target couldn't read the personal settings: ${r.status}`)
  for (const rec of r.json.items as { key: string; value: unknown; rev: number }[]) {
    if (rec.value === null || rec.key === 'g:name') continue
    const done = await s.api('admin', 'PUT', `/api/settings/personal/${encodeURIComponent(rec.key)}`, { value: null, ifRev: rec.rev })
    if (done.status >= 300) throw new Error(`The real contract target couldn't unset ${rec.key}: ${done.status}`)
  }
}
