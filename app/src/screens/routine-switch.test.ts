// A routine's switch while the agent is paused. Ways it could break, written down before the code:
//  - the global pause turns every enabled routine's switch off, so it reads as disabled;
//  - a click on that switch then saves "off" for a routine the person meant to keep on (or "on" for one that was off).
import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { routineSwitch } from './routine-switch'

describe('routineSwitch', () => {
  test('an enabled routine shows on while the agent is paused, and a click saves it off', () => {
    expect(routineSwitch({ on: true }, true)).toEqual({ on: true, turnsTo: false })
  })
  test('a routine switched off shows off while paused, and a click saves it on', () => {
    expect(routineSwitch({ on: false }, true)).toEqual({ on: false, turnsTo: true })
  })
  test('the switch is the routine\'s own setting whatever the pause, and a click always saves the other one', () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (on, paused) => {
      const s = routineSwitch({ on }, paused)
      expect(s.on).toBe(on)
      expect(s.turnsTo).toBe(!s.on)
      expect(routineSwitch({ on }, !paused)).toEqual(s)
    }))
  })
})
