// M3-J: since the fetch default flipped (a brand with no mode set and no host listed reads any public host), no eval case
// may run with open fetch unless it asks for it. Every seed writes the mode it means (`webfetchSeedFor`: `list`, or
// `open` only for a case whose spec says `fetch: 'open'`), so the flip can't widen a case silently, whatever host list
// the seed leaves (#721 leaves none for an injection plant). Ways it could fail, written first:
//  1. a product-suite, injection or read-side case reads as open to the server without asking (its mode left unset, or
//     written as `open`), or an open-fetch case reads as the list;
//  2. the test passes vacuously: no case asks for open, or no case in a suite is checked.
// Each case's settings are read the way the server reads them (`webFetchMode` of the mode and the list the seed leaves).
// That the seed writes exactly `webfetchSeedFor`'s answer is evals/product.test.ts's ('mode list' for N01, 'mode open'
// for X16); the door writing `list` as a row, not deleting it, is exfiltration/open-fetch/egress.test.ts's.
import { describe, expect, it } from 'vitest'
import { webFetchMode } from '../shared/contract/settings-table.ts'
import { CASES } from './cases.ts'
import { INJECTION_CASES } from './injection/cases.ts'
import { plantSpecOf } from './injection/product.ts'
import { READ_SIDE_CASES } from './read-side/cases.ts'
import { planOf } from './read-side/product/target.ts'
import { webfetchSeedFor } from './targets/product.ts'
import type { ExfilSpec } from './types.ts'

/** The mode the server reads after the product seed (and, for read-side, the hosts its target sets after the seed). */
const served = (exfil: ExfilSpec | undefined, hostsAfter?: string[]): 'list' | 'open' => {
  const web = webfetchSeedFor(exfil)
  const hosts = hostsAfter ?? web.hosts
  return webFetchMode(web.mode, hosts === null ? undefined : hosts.join('\n'))
}

describe('no eval case runs with open fetch unless it asks (M3-J)', () => {
  it('the default it guards against: no mode and no host list is open', () => {
    expect(webFetchMode(undefined, undefined)).toBe('open')
  })

  it('the product suite: only the open-fetch cases (X13 to X18) read as open', () => {
    const open = CASES.filter((c) => served(c.exfil) === 'open').map((c) => c.id)
    expect(open).toEqual(CASES.filter((c) => c.exfil?.fetch === 'open').map((c) => c.id))
    expect(open).toEqual(['X13', 'X14', 'X15', 'X16', 'X17', 'X18'])
    expect(CASES.length).toBeGreaterThan(open.length)
  })

  it('the write-injection set: every case reads as the list', () => {
    expect(INJECTION_CASES.length).toBeGreaterThan(0)
    expect(INJECTION_CASES.filter((c) => served(plantSpecOf(c)) !== 'list').map((c) => c.id)).toEqual([])
  })

  it('the read-side set: every case reads as the list, with the hosts its target sets after the seed', () => {
    const planned = READ_SIDE_CASES.flatMap((c) => {
      try {
        return [{ id: c.id, plan: planOf(c) }]
      } catch (e) {
        // Only the Slack plants have no plan yet (they wait on P5): anything else is a failure here.
        expect(String(e), c.id).toMatch(/plants in Slack/)
        return []
      }
    })
    expect(planned.length).toBeGreaterThan(0)
    expect(planned.filter(({ plan }) => served(plan.exfil, plan.hosts) !== 'list').map(({ id }) => id)).toEqual([])
  })
})
