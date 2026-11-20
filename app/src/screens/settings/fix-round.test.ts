// Fix round 1 of #106, the pure parts: a grant's status text, the busy guard, the stale-save words, Retry, Sign out, the avatar's photo and the request line.
import { describe, expect, it, vi } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { grantStatus } from './grant-status'
import { single } from './single'
import { nowIs } from './now-is'
import { canRetry } from '../../ui/retry-rule'
import { signOutAction } from '../../overlays/account'
import { pickPhoto } from '../../ui/photo'
import { instantOf } from '../../lib/format'
import type { Display } from '../../lib/format'

const D: Display = { timeZone: 'America/New_York', locale: 'en-US' }
const at = (iso: string) => instantOf(Date.parse(iso))
const grant = (endsAt: string, live: boolean, endedAt: string | null = null) => ({ id: 'g_x', createdBy: 'm_a', createdAt: at('2026-11-16T12:00:00Z'), endsAt: at(endsAt), endedAt: endedAt ? at(endedAt) : null, endedBy: null, rev: 1, live })
const NOW = Date.parse('2026-11-16T17:00:00Z')

describe('grantStatus', () => {
  it('says Off with no grant', () => expect(grantStatus(null, NOW, D)).toBe('Off'))
  it('gives only the time when it is today', () => expect(grantStatus(grant('2026-11-16T20:00:00Z', true), NOW, D)).toBe('Live until 3:00 PM'))
  it('names the day when it is not today', () => {
    expect(grantStatus(grant('2026-11-18T20:00:00Z', true), NOW, D)).toBe('Live until Wed, Nov 18, 3:00 PM')
    expect(grantStatus(grant('2026-11-16T20:00:00Z', false, '2026-11-14T20:00:00Z'), NOW, D)).toBe('Ended Sat, Nov 14, 3:00 PM')
  })
})

describe('single', () => {
  it('runs one request at a time and frees the guard when it settles, even on failure', async () => {
    const seen: boolean[] = []
    let release!: () => void
    let calls = 0
    const run = single(() => { calls++; return new Promise<void>((_, rej) => { release = () => rej(new Error('no')) }) }, b => seen.push(b))
    expect(run()).toBe(true)
    expect(run()).toBe(false)
    expect(calls).toBe(1)
    release()
    await vi.waitFor(() => expect(seen).toEqual([true, false]))
    expect(run()).toBe(true)
    expect(calls).toBe(2)
  })
})

describe('nowIs', () => {
  test.prop([fc.string({ minLength: 1 })])('maps a stored value through the row labels, never a raw id', id => {
    expect(nowIs({ value: id }, { labels: { [id]: 'Dana Kim' } })).toBe('Dana Kim')
  })
  it('names a null as the row default, through its labels', () => {
    expect(nowIs({ value: null }, { defaultValue: 'America/New_York', labels: { 'America/New_York': 'Eastern Time (New York)' } })).toBe('Eastern Time (New York)')
    expect(nowIs({ value: null })).toBe('the default')
  })
})

describe('Retry', () => {
  it('is offered for a failure that can pass, and not for who-you-are refusals', () => {
    expect(['offline', 'unavailable', 'unknown', 'rate_limited'].every(c => canRetry(c as never))).toBe(true)
    expect(canRetry('forbidden')).toBe(false)
    expect(canRetry('unauthorized')).toBe(false)
  })
})

describe('Sign out', () => {
  it('goes to the sign-out address when the client has one, else the demo says so', () => {
    expect(signOutAction('/cdn-cgi/access/logout')).toEqual({ go: '/cdn-cgi/access/logout' })
    expect(signOutAction(null)).toEqual({ demo: true })
  })
})

describe('pickPhoto', () => {
  it('uses me().photoUrl only for the signed-in person', () => {
    expect(pickPhoto(null, true, '/api/members/m_a/photo')).toBe('/api/members/m_a/photo')
    expect(pickPhoto(null, false, '/api/members/m_a/photo')).toBeNull()
    expect(pickPhoto('data:x', true, '/api/members/m_a/photo')).toBe('data:x')
    expect(pickPhoto('', true, null)).toBeNull()
  })
})
