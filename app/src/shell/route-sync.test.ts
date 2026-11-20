import { describe, expect, it } from 'vitest'
import { mayWriteHash } from './route-sync'

describe('mayWriteHash', () => {
  it('writes when the app moved', () => {
    expect(mayWriteHash(true, '#/usage', '#/settings/team-spend', true)).toBe(true)
  })
  it('writes when the hash already is the app\'s own', () => {
    expect(mayWriteHash(false, '#/settings/team-spend', '#/settings/team-spend', true)).toBe(true)
  })
  it('waits for the listener when only the layout changed and someone set another readable hash', () => {
    expect(mayWriteHash(false, '#/usage', '#/settings/team-spend', true)).toBe(false)
  })
  it('tidies a hash the app cannot read', () => {
    expect(mayWriteHash(false, '#/nowhere', '#/settings/team-spend', false)).toBe(true)
  })
})
