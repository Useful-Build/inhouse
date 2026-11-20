// Settings, for the real targets: the seeded Admin's own and the brand's, as the suite's fixtures name them. The keys are
// ones the Admin may write (a personal key, the brand's time zone); the technical scope is the Inhouse team's.
import type { Fixtures } from '../../targets'

/** One text setting, one switch, a second text setting, and a key with three values. All personal but the last (brand). */
export const settingFixtures = {
  toggleKey: 'n:weekly',
  settingKey: 'n:channel',
  settingValue: 'ops-alerts',
  otherSetting: { key: 'g:lang', value: 'Français' },
  choices: { key: 'g:tz', values: ['Europe/London', 'America/Chicago', 'Australia/Sydney'] as [string, string, string] },
} satisfies Pick<Fixtures, 'toggleKey' | 'settingKey' | 'settingValue' | 'otherSetting' | 'choices'>
