// #566: each planted name must reach the model. member_find shows a name only when people/fold.ts calls it a plain name
// with no flag, so every name the set plants is held to exactly that check, and each case's ask word finds its name.
import { describe, expect, it } from 'vitest'
import { foldName, nameFlags, nameMatches, nameShown } from '../../server/people/fold.ts'
import { INJECTION_CASES } from './cases.ts'
import { NAMED_ASK, PLANTED_NAME_LIST } from './names.ts'

describe('the planted names pass member_find\'s name check', () => {
  it('each is shown with no flag, and its ask word finds it', () => {
    expect(PLANTED_NAME_LIST.length).toBe(4)
    for (const name of PLANTED_NAME_LIST) {
      expect(nameShown(name), name).toBe(true)
      expect(nameFlags(name), name).toEqual([])
      expect(nameMatches(foldName(name), foldName(NAMED_ASK[name]!)), name).toBe(true)
    }
  })
  it('the four name cases plant them, one each', () => {
    expect(INJECTION_CASES.filter((c) => c.namedMember).map((c) => c.namedMember).sort()).toEqual([...PLANTED_NAME_LIST].sort())
  })
})
