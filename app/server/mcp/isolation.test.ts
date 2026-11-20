// The one visibility rule (p3-design section 10), across `memory_search`, `memory_list`, `history_search`,
// `history_read` (through the MCP server, as each run's person) and route 43. Ways it can fail, written down first:
//  1. member A sees B's person facts or B's chats, in any of the five;
//  2. anyone sees a waiting or a forgotten fact, or a deleted chat;
//  3. the rule is vacuous: an always-empty answer passes (so each seeded item must first be found by its owner).
// The oracle is the seed record below (who may see each literal item), never the code under test.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { listMemory } from '../api/memory.ts'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal } from '../db/test-support.ts'
import { handleMcp } from './server/index.ts'

const db = env.DB
const stores = openStores(env)
const A = 'm_iso_a'
const B = 'm_iso_b'
type Who = typeof A | typeof B

/** Every seeded fact: its text and who may see it (the oracle). */
const FACTS: { id: string; text: string; scope: 'brand' | 'person'; owner: Who | null; status: 'active' | 'waiting' | 'forgotten'; seenBy: Who[] }[] = [
  { id: 'mem_isoAaaaaaaaaaaaaaaaaaa', text: 'Alpha prefers order tables sorted by date', scope: 'person', owner: A, status: 'active', seenBy: [A] },
  { id: 'mem_isoAforgottenaaaaaaaa', text: 'Alpha liked compact supplier tables', scope: 'person', owner: A, status: 'forgotten', seenBy: [] },
  { id: 'mem_isoBbbbbbbbbbbbbbbbbbb', text: 'Bravo wants invoices grouped by supplier', scope: 'person', owner: B, status: 'active', seenBy: [B] },
  { id: 'mem_isoBforgottenbbbbbbbb', text: 'Bravo once asked for weekly order digests', scope: 'person', owner: B, status: 'forgotten', seenBy: [] },
  { id: 'mem_isoTeamactiveeeeeeeee', text: 'We restock the warehouse on Fridays', scope: 'brand', owner: null, status: 'active', seenBy: [A, B] },
  { id: 'mem_isoTeamwaitingggggggg', text: 'Kestrel supplier wants order PDFs by Friday', scope: 'brand', owner: null, status: 'waiting', seenBy: [] },
  { id: 'mem_isoTeamforgottennnnnn', text: 'Old supplier order cutoff was Thursday', scope: 'brand', owner: null, status: 'forgotten', seenBy: [] },
]
/** Every seeded chat (one message each): who may see it. */
const CHATS: { id: string; owner: Who; deleted: boolean; text: string; seenBy: Who[] }[] = [
  { id: 'c_iso_a', owner: A, deleted: false, text: 'Alpha asked about the returns policy and supplier order dates', seenBy: [A] },
  { id: 'c_iso_a_deleted', owner: A, deleted: true, text: 'Alpha discussed secret supplier pricing for orders', seenBy: [] },
  { id: 'c_iso_b', owner: B, deleted: false, text: 'Bravo asked which warehouse handles supplier returns and orders', seenBy: [B] },
]
const WORDS = [...new Set([...FACTS, ...CHATS].flatMap(x => x.text.toLowerCase().match(/[a-z]+/g)!))]

let calls = 0
async function tool(who: Who, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const scope = { memberId: who, chatId: 'c_now', runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA' }
  const res = await handleMcp(new Request('http://egress.internal/mcp/', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: ++calls, method: 'tools/call', params: { name, arguments: args } }) }), scope, { db, now: () => 1_800_000_000_000 })
  const body = (await res.json()) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } }
  return { ...body.result.structuredContent, ...(body.result.isError ? { isError: true } : {}) }
}

/** Every fact text and chat id one member reaches through the five ways, for one query. */
async function reached(who: Who, query: string) {
  const texts = new Set<string>()
  const chats = new Set<string>()
  for (const f of (await tool(who, 'memory_search', { query, limit: 20 })).facts as { text: string }[]) texts.add(f.text)
  let cursor: string | null = null
  do {
    const page = await tool(who, 'memory_list', cursor ? { limit: 2, cursor } : { limit: 2 })
    for (const f of page.facts as { text: string }[]) texts.add(f.text)
    cursor = page.next_cursor as string | null
  } while (cursor)
  for (const h of (await tool(who, 'history_search', { query, limit: 20 })).matches as { chat_id: string }[]) chats.add(h.chat_id)
  for (const c of CHATS) if (!(await tool(who, 'history_read', { chat_id: c.id })).isError) chats.add(c.id)
  const page = (await (await listMemory(ctx(stores, personPrincipal(who, 'member'), { path: '/api/memory' }).c)).json()) as { team: { lines: { text: string }[] }[]; personal: { text: string }[] }
  for (const l of [...page.team.flatMap(g => g.lines), ...page.personal]) texts.add(l.text)
  return { texts, chats }
}

beforeAll(async () => {
  await db.batch([
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Alpha', 1)").bind(A),
    db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Bravo', 1)").bind(B),
    ...FACTS.map(f => db.prepare('INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, 1, 1)')
      .bind(f.id, f.scope, f.owner, f.text, f.status, f.owner ?? A)),
    ...CHATS.flatMap(c => [
      db.prepare('INSERT INTO chats (id, owner_id, title, deleted_at_ms, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, 1, 1)').bind(c.id, c.owner, `Chat ${c.id}`, c.deleted ? 5 : null),
      db.prepare("INSERT INTO chat_messages (id, chat_id, run_id, turn_id, pos, role, text, at_ms) VALUES (?, ?, 'r_1', ?, 0, 'user', ?, 1)").bind(`${c.id}.u`, c.id, `t_${c.id}`, c.text),
    ]),
  ])
})

describe('each owner finds what is theirs (failure 3: the rule is not vacuous)', () => {
  it('A and B each reach exactly the items the seed record gives them, through all five', async () => {
    for (const who of [A, B] as const) {
      const all = { texts: new Set<string>(), chats: new Set<string>() }
      for (const q of ['supplier', 'order', 'returns', 'tables', 'invoices', 'restock']) {
        const r = await reached(who, q)
        r.texts.forEach(t => all.texts.add(t))
        r.chats.forEach(c => all.chats.add(c))
      }
      expect([...all.texts].sort(), who).toEqual(FACTS.filter(f => f.seenBy.includes(who)).map(f => f.text).sort())
      expect([...all.chats].sort(), who).toEqual(CHATS.filter(c => c.seenBy.includes(who)).map(c => c.id).sort())
    }
    // Each search finds its owner's item by a word of it (not only the list).
    expect(((await tool(A, 'memory_search', { query: 'sorted' })).facts as { text: string }[]).map(f => f.text)).toEqual([FACTS[0].text])
    expect(((await tool(B, 'memory_search', { query: 'grouped' })).facts as { text: string }[]).map(f => f.text)).toEqual([FACTS[2].text])
    expect(((await tool(A, 'history_search', { query: 'policy' })).matches as { chat_id: string }[]).map(h => h.chat_id)).toEqual(['c_iso_a'])
    expect(((await tool(B, 'history_search', { query: 'warehouse' })).matches as { chat_id: string }[]).map(h => h.chat_id)).toEqual(['c_iso_b'])
  })
})

describe('isolation under any query (failures 1 and 2)', () => {
  test.prop([fc.constantFrom(A, B), fc.oneof(
    fc.array(fc.constantFrom(...WORDS), { minLength: 1, maxLength: 4 }).map(w => w.join(' ')),
    fc.array(fc.constantFrom(...WORDS), { minLength: 2, maxLength: 3 }).map(w => `"${w.join(' ')}"`),
    fc.string({ minLength: 1, maxLength: 40 }),
  )], { numRuns: 25 })('a member never reaches an item the seed record doesn\'t give them', async (who, query) => {
    const { texts, chats } = await reached(who, query)
    const factsSeen = FACTS.filter(f => f.seenBy.includes(who)).map(f => f.text)
    const chatsSeen = CHATS.filter(c => c.seenBy.includes(who)).map(c => c.id)
    for (const t of texts) expect(factsSeen, `${who} reached "${t}" with ${JSON.stringify(query)}`).toContain(t)
    for (const c of chats) expect(chatsSeen, `${who} reached chat ${c} with ${JSON.stringify(query)}`).toContain(c)
  })
})
