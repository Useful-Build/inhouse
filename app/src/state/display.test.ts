import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBrandZone, display } from './display'
import { deviceTimeZone } from '../lib/format'

afterEach(() => { setBrandZone(() => undefined) })

describe('display', () => {
  it('uses the device zone until the brand has one, then the brand zone', () => {
    setBrandZone(() => undefined)
    expect(display().timeZone).toBe(deviceTimeZone())
    setBrandZone(() => 'Europe/London')
    expect(display().timeZone).toBe('Europe/London')
    setBrandZone(() => 'Australia/Sydney')
    expect(display().timeZone).toBe('Australia/Sydney')
  })
  it('gives the same object while the zone is the same', () => {
    setBrandZone(() => 'Europe/Paris')
    expect(display()).toBe(display())
  })
  it('falls back to the device zone for a zone Intl refuses, and says so once, without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    setBrandZone(() => 'Mars/Olympus')
    expect(display().timeZone).toBe(deviceTimeZone())
    expect(display().timeZone).toBe(deviceTimeZone())
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
