import { describe, expect, it } from 'vitest'
import type { AgentData, ResourceKey, ResourceStatus } from '../agent/types'
import { RESOURCE_KEYS } from '../../shared/contract/keys'
import { notOnTeam } from './not-on-team'

const at = (meta: ResourceStatus) => ({ resources: Object.fromEntries(RESOURCE_KEYS.map(k => [k, k === 'meta' ? meta : { status: 'ready' }])) as Record<ResourceKey, ResourceStatus> }) as Pick<AgentData, 'resources'>

describe('notOnTeam', () => {
  it('is true for a 403 not_invited or removed', () => {
    expect(notOnTeam(at({ status: 'error', error: 'forbidden', reason: 'not_invited' }))).toBe(true)
    expect(notOnTeam(at({ status: 'error', error: 'forbidden', reason: 'removed' }))).toBe(true)
  })
  it('is false for any other failure, reason or state', () => {
    expect(notOnTeam(at({ status: 'error', error: 'forbidden' }))).toBe(false)
    expect(notOnTeam(at({ status: 'error', error: 'forbidden', reason: 'grant_required' }))).toBe(false)
    expect(notOnTeam(at({ status: 'error', error: 'offline', reason: 'not_invited' }))).toBe(false)
    expect(notOnTeam(at({ status: 'loading' }))).toBe(false)
    expect(notOnTeam(at({ status: 'ready' }))).toBe(false)
  })
})
