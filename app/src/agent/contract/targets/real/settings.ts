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
  const list = (scope: string) => listSettings(s, scope)
  /**
   * Puts `key` to `value` at `rev`. A 409 means the key was written after the list was read: the rev is read again and the
   * put made at that one (at most 3 puts). Never the listed rev twice: a case that timed out can still land one last write
   * after its test ended (#466), and that 409 failed the next test's reset.
   */
  const put = async (scope: string, key: string, value: unknown, rev: number) => {
    for (let pass = 1; ; pass++) {
      const done = await s.api('admin', 'PUT', `/api/settings/${scope}/${encodeURIComponent(key)}`, { value, ifRev: rev })
      if (done.status < 300) return
      if (done.status !== 409 || pass === 3) throw new Error(`The real contract target couldn't put ${key} back: ${done.status} (put ${pass} of 3)`)
      const now = (await list(scope)).find(r => r.key === key)
      if (!now) throw new Error(`The real contract target couldn't put ${key} back: 409, and the ${scope} settings no longer list it`)
      if (now.value === value) return
      rev = now.rev
    }
  }
  for (const rec of await list('personal')) {
    if (rec.value !== null && rec.key !== 'g:name') await put('personal', rec.key, null, rec.rev)
  }
  const seeded = (key: string) => SEED_SETTINGS.find(([scope, k]) => scope === 'brand' && k === key)?.[2] ?? null
  for (const rec of await list('brand')) {
    if (rec.key === settingFixtures.choices.key && rec.value !== seeded(rec.key)) await put('brand', rec.key, seeded(rec.key), rec.rev)
  }
}

/** One scope's setting records, read as the seeded Admin. */
async function listSettings(s: Signer, scope: string): Promise<{ key: string; value: unknown; rev: number }[]> {
  const r = await s.api('admin', 'GET', `/api/settings/${scope}`)
  if (r.status !== 200) throw new Error(`The real contract target couldn't read the ${scope} settings: ${r.status}`)
  return r.json.items as { key: string; value: unknown; rev: number }[]
}

/**
 * A setting written by a second session of the seeded Admin, which the client under test doesn't know of: the key's
 * current rev read, then a write at that rev (the request a second client would send). Two requests: a second `HttpAgent`
 * first loads all twenty of its reads, about 20 extra requests per stale write, which kept the stale-write property near
 * its 25 s limit on a busy runner (#466). Fails loud on any refusal, as the client's own write would reject.
 */
export async function setSettingElsewhere(s: Signer, scope: string, key: string, value: string | boolean | null): Promise<void> {
  const rev = (await listSettings(s, scope)).find(r => r.key === key)?.rev ?? 0
  const done = await s.api('admin', 'PUT', `/api/settings/${scope}/${encodeURIComponent(key)}`, { value, ifRev: rev })
  if (done.status >= 300) throw new Error(`The real contract target couldn't change ${key} elsewhere: ${done.status} ${JSON.stringify(done.json)}`)
}
