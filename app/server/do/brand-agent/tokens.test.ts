// Run tokens (p3-design section 5) on the BrandAgent's real SQLite (`runInDurableObject`). Expected values are literals,
// the test's own SHA-256, or a reference list the test keeps. Ways it can fail, written down first:
//  1. a token checks to another grant, or a route stays open after `closeRoutes` closed it (or `store`/`events` close
//     with the first step);
//  2. a revoked, expired (exactly at `expiresAtMs`) or unknown token passes, or the wrong refusal is named;
//  3. the table holds the raw token anywhere (any column);
//  4. `revokeMember` revokes another member's token or misses one of the member's.
import { fc, test } from '@fast-check/vitest'
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createRunTokens, hashRunToken } from './tokens.ts'
import type { EgressRoute, RunTokens } from './tokens.ts'

const T = 4_102_444_800_000
const ALL: EgressRoute[] = ['model', 'mcp', 'store', 'files', 'events', 'audit']
let n = 0
/** A fresh BrandAgent's storage and run tokens over it. */
const withTokens = <R>(fn: (tokens: RunTokens, sql: SqlStorage) => Promise<R>) =>
  runInDurableObject(env.BRAND_AGENT.getByName(`tokens-${++n}`), (_i, state) => fn(createRunTokens(state.storage.sql, () => T), state.storage.sql))
const grant = (turn: string, member = 'm_a') => ({
  turnId: turn, runId: 'r_run', chatId: 'chat-1', memberId: member, sessionId: '00000000-0000-4000-8000-000000000001',
  model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5',
})
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('')

describe('a minted token (failures 1, 3)', () => {
  it('checks to its grant on every route, and closes in two steps', async () => {
    await withTokens(async tokens => {
      const token = await tokens.mint(grant('t_1'), T)
      const other = await tokens.mint(grant('t_2'), T)
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const hash = await sha256(token)
      expect(await hashRunToken(token)).toBe(hash)
      for (const r of ALL) expect(tokens.check(hash, r, T), r).toEqual({ ...grant('t_1'), subagentModel: null, expiresAtMs: T + 2_700_000 })
      tokens.closeRoutes('t_1', ['model', 'mcp', 'files', 'audit'], 'terminal')
      for (const r of ['model', 'mcp', 'files', 'audit'] as const) expect(tokens.check(hash, r, T), r).toEqual({ refused: 'closed' })
      for (const r of ['store', 'events'] as const) expect(tokens.check(hash, r, T), r).toMatchObject({ turnId: 't_1' })
      tokens.closeRoutes('t_1', ['store', 'events'], 'released')
      for (const r of ALL) expect(tokens.check(hash, r, T), r).toEqual({ refused: 'closed' })
      // Another turn's token is untouched.
      for (const r of ALL) expect(tokens.check(await sha256(other), r, T), r).toMatchObject({ turnId: 't_2' })
    })
  })
  it('is never stored raw, in any column', async () => {
    await withTokens(async (tokens, sql) => {
      const minted = [await tokens.mint(grant('t_1'), T), await tokens.mint(grant('t_2', 'm_b'), T)]
      tokens.revokeTurn('t_2', 'stopped')
      const rows = [...sql.exec('SELECT * FROM run_tokens').raw()]
      expect(rows).toHaveLength(2)
      for (const row of rows) for (const cell of row) for (const t of minted) expect(String(cell).includes(t)).toBe(false)
      expect(rows.map(r => r[0]).sort()).toEqual((await Promise.all(minted.map(sha256))).sort())
    })
  })
})

describe('refusals (failure 2)', () => {
  it('names revoked, expired (exactly at expiresAtMs) and unknown', async () => {
    await withTokens(async tokens => {
      const hash = await sha256(await tokens.mint(grant('t_1'), T))
      expect(tokens.check(hash, 'model', T + 2_699_999)).toMatchObject({ turnId: 't_1' })
      expect(tokens.check(hash, 'model', T + 2_700_000)).toEqual({ refused: 'expired' })
      expect(tokens.check('0'.repeat(64), 'model', T)).toEqual({ refused: 'unknown' })
      expect(tokens.check(hash.toUpperCase(), 'model', T)).toEqual({ refused: 'unknown' })
      tokens.revokeTurn('t_1', 'fenced')
      expect(tokens.check(hash, 'store', T)).toEqual({ refused: 'revoked' })
      expect(tokens.check(hash, 'store', T + 2_700_000)).toEqual({ refused: 'revoked' })
      const again = await sha256(await tokens.mint(grant('t_3'), T))
      tokens.revokeAll('drain')
      expect(tokens.check(again, 'events', T)).toEqual({ refused: 'revoked' })
    })
  })
})

describe('revokeMember (failure 4)', () => {
  const op = fc.oneof(
    fc.record({ mint: fc.constantFrom('m_a', 'm_b', 'm_c') }),
    fc.record({ revokeMember: fc.constantFrom('m_a', 'm_b', 'm_c', 'm_z') }),
  )
  test.prop([fc.array(op, { minLength: 1, maxLength: 15 })], { numRuns: 30 })('revokes exactly the member\'s tokens minted before it', async ops => {
    await withTokens(async tokens => {
      // The reference: each minted token's hash, member, and whether a revoke of its member came after it.
      const ref: { hash: string; member: string; revoked: boolean }[] = []
      let i = 0
      for (const o of ops) {
        if ('mint' in o) ref.push({ hash: await sha256(await tokens.mint(grant(`t_${i++}`, o.mint), T)), member: o.mint, revoked: false })
        else {
          tokens.revokeMember(o.revokeMember, 'removed')
          for (const r of ref) if (r.member === o.revokeMember) r.revoked = true
        }
      }
      for (const r of ref) {
        const got = tokens.check(r.hash, 'model', T)
        if (r.revoked) expect(got).toEqual({ refused: 'revoked' })
        else expect(got).toMatchObject({ memberId: r.member })
      }
    })
  })
})
