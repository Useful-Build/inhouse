// The 50-per-turn bound on unpriced count_tokens calls (p3-design 8.2), on real DO SQLite, and the fake's same
// contract. Expected values are literals. Ways it can fail, written down first:
//  1. the 50th call is refused, or the 51st passes;
//  2. one turn's count spends another's;
//  3. an unknown turn passes;
//  4. the fake answers differently from the real one (W3 tests against the fake).
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { noteCountTokens } from './count-tokens.ts'
import { FakeBrandAgentRpc } from './testing/fake-brand-agent-rpc.ts'

/** The answers of calls 1 to `n`. */
const answers = async (note: () => boolean | Promise<boolean>, n: number) => {
  const out: boolean[] = []
  for (let i = 0; i < n; i++) out.push(await note())
  return out
}
const expected = (n: number) => Array.from({ length: n }, (_, i) => i < 50)

describe('noteCountTokens (failures 1-3)', () => {
  it('passes calls 1 to 50 of a turn and refuses the 51st on; other turns and unknown turns apart', async () => {
    await runInDurableObject(env.BRAND_AGENT.getByName('count-tokens'), async (_i, state) => {
      const sql = state.storage.sql
      // The real `turns` table (schema.ts, created by the object on start), with two minimal rows.
      for (const id of ['t_a', 't_b']) {
        sql.exec(`INSERT INTO turns (turn_id, run_id, chat_id, owner_id, ord, client_key, payload_hash, state, priority, text,
          attachments_json, model, picker_id, side_model, effort, max_turns, answer_position, created_at_ms)
          VALUES (?, 'r_x', ?, 'm_x', 0, ?, 'h', 'live', 'next', 'q', '[]', 'm', 'p', 's', 'low', 25, 'starting', 0)`, id, `c_${id}`, `key-${id}`)
      }
      const a = await answers(() => noteCountTokens(sql, 't_a'), 51)
      expect(a.slice(48)).toEqual([true, true, false]) // calls 49, 50, 51
      expect(a).toEqual(expected(51))
      expect(noteCountTokens(sql, 't_b')).toBe(true)
      expect(noteCountTokens(sql, 't_none')).toBe(false)
      expect(sql.exec("SELECT count_tokens_calls AS n FROM turns WHERE turn_id = 't_a'").one().n).toBe(50)
    })
  })
})

describe('the fake (failure 4)', () => {
  it('answers the same at 49, 50 and 51, and false for an unknown turn', async () => {
    const fake = new FakeBrandAgentRpc()
    fake.turns.add('t_a').add('t_b')
    const a = await answers(() => fake.noteCountTokens('t_a'), 51)
    expect(a.slice(48)).toEqual([true, true, false])
    expect(a).toEqual(expected(51))
    expect(await fake.noteCountTokens('t_b')).toBe(true)
    expect(await fake.noteCountTokens('t_none')).toBe(false)
  })
})
