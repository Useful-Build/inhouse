// Search matches word forms (eval R02: "return window policy" found nothing, though a brand fact says "Returns ... 45
// days"). Ways it can fail, written down first:
//  1. a query word misses a saved word of the same stem (return/returns/returned, ship/shipping), in facts or history;
//  2. the R02 query still finds nothing;
//  3. an exact word or a quoted phrase stops matching, or a phrase matches out of order;
//  4. a code the agent is asked about (an order "PO-1187", an invoice "#4821") stops being found by its digits or its
//     parts;
//  5. the wider matching reaches past the visibility rule: a member finds another member's person facts, a waiting or
//     forgotten fact, or another member's (or a deleted) chat. That's the must-not.
// The oracle is the seed record below (each item's stem family and who may see it), never the code under test.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { historyStore } from './tools/history/store.ts'
import { memoryStore } from './tools/memory/store.ts'

const db = env.DB
const memory = memoryStore({ db })
const history = historyStore({ db })
const A = 'm_stem_a'
const B = 'm_stem_b'
type Who = typeof A | typeof B

/** Inflected forms that a reader takes for one word. Each family's forms must find each other. */
const FAMILIES = {
  return: ['return', 'returns', 'returned', 'returning'],
  ship: ['ship', 'ships', 'shipped', 'shipping'],
  refund: ['refund', 'refunds', 'refunded', 'refunding'],
  exchange: ['exchange', 'exchanges', 'exchanged', 'exchanging'],
  pack: ['pack', 'packs', 'packed', 'packing'],
} as const
type Family = keyof typeof FAMILIES

/** Every seeded fact: the family it holds (one form of it), and who may see it. */
const FACTS: { id: string; text: string; family: Family; scope: 'brand' | 'person'; owner: Who | null; status: 'active' | 'waiting' | 'forgotten'; seenBy: Who[] }[] = [
  { id: 'mem_stemR02aaaaaaaaaaaaaa', text: 'Returns are accepted within 45 days of delivery', family: 'return', scope: 'brand', owner: null, status: 'active', seenBy: [A, B] },
  { id: 'mem_stemAshipaaaaaaaaaaaa', text: 'Alpha wants orders shipped in plain boxes', family: 'ship', scope: 'person', owner: A, status: 'active', seenBy: [A] },
  { id: 'mem_stemBrefundbbbbbbbbbb', text: 'Bravo approves refunding damaged mugs', family: 'refund', scope: 'person', owner: B, status: 'active', seenBy: [B] },
  { id: 'mem_stemBexchangebbbbbbbb', text: 'Bravo exchanges sizes without a fee', family: 'exchange', scope: 'person', owner: B, status: 'forgotten', seenBy: [] },
  { id: 'mem_stemTeampackingwaitin', text: 'Packing slips go in every parcel', family: 'pack', scope: 'brand', owner: null, status: 'waiting', seenBy: [] },
  { id: 'mem_stemTeamshipforgotten', text: 'Ships from the old warehouse on Mondays', family: 'ship', scope: 'brand', owner: null, status: 'forgotten', seenBy: [] },
]
/** Every seeded chat (one user message each): the family it holds, and who may see it. */
const CHATS: { id: string; owner: Who; deleted: boolean; text: string; family: Family; seenBy: Who[] }[] = [
  { id: 'c_stem_a', owner: A, deleted: false, text: 'Alpha asked how returned parcels are logged', family: 'return', seenBy: [A] },
  { id: 'c_stem_b', owner: B, deleted: false, text: 'Bravo asked about shipping to the islands', family: 'ship', seenBy: [B] },
  { id: 'c_stem_b_deleted', owner: B, deleted: true, text: 'Bravo discussed refunds for the spring sale', family: 'refund', seenBy: [] },
]

const factsFound = async (who: Who, q: string) => (await memory.search(who, q, 50, 5)).map(f => f.id).sort()
const chatsFound = async (who: Who, q: string) =>
  [...new Set((await history.search(who, q, { afterMs: null, beforeMs: null, limit: 50 })).map(h => h.chatId))].sort()

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

describe('eval R02 (failure 2)', () => {
  it('"return window policy" finds the saved returns fact', async () => {
    expect(await factsFound(A, 'return window policy')).toEqual(['mem_stemR02aaaaaaaaaaaaaa'])
    expect(await factsFound(B, 'return window policy')).toEqual(['mem_stemR02aaaaaaaaaaaaaa'])
  })
})

describe('word forms find each other (failure 1)', () => {
  test.prop([fc.constantFrom(A, B), fc.constantFrom(...Object.keys(FAMILIES) as Family[]).chain(f => fc.constantFrom(...FAMILIES[f]).map(form => [f, form] as const))],
    { numRuns: 40 })('any form of a word finds every visible item holding another form of it', async (who, [family, form]) => {
    expect(await factsFound(who, form), `${who} searching facts for ${form}`)
      .toEqual(FACTS.filter(f => f.family === family && f.seenBy.includes(who)).map(f => f.id).sort())
    expect(await chatsFound(who, form), `${who} searching history for ${form}`)
      .toEqual(CHATS.filter(c => c.family === family && c.seenBy.includes(who)).map(c => c.id).sort())
  })
})

describe('exact words and phrases still match (failure 3)', () => {
  it('the saved word itself, any case, and phrases in order only', async () => {
    expect(await factsFound(A, 'Returns')).toEqual(['mem_stemR02aaaaaaaaaaaaaa'])
    expect(await factsFound(A, 'delivery')).toEqual(['mem_stemR02aaaaaaaaaaaaaa'])
    expect(await factsFound(A, '"plain boxes"')).toEqual(['mem_stemAshipaaaaaaaaaaaa'])
    expect(await factsFound(A, '"orders ship"')).toEqual(['mem_stemAshipaaaaaaaaaaaa'])
    expect(await factsFound(A, '"boxes plain"')).toEqual([])
    expect(await chatsFound(B, '"shipped to the island"')).toEqual(['c_stem_b'])
    expect(await factsFound(A, 'turn')).toEqual([])
  })
})

describe('codes (failure 4)', () => {
  const CODE = 'mem_stemCodesaaaaaaaaaaaa'
  const SKU = 'mem_stemSkuaaaaaaaaaaaaaa'
  const SKU_S = 'mem_stemSkusaaaaaaaaaaaaa'
  beforeAll(async () => {
    await db.batch([[CODE, 'Order PO-1187 goes out with invoice #4821'], [SKU, 'SKU ABC123 is the blue mug'], [SKU_S, 'SKU ABC123S is the small blue mug']]
      .map(([id, text]) => db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES (?, 'brand', NULL, ?, 'active', ?, 1, 1)").bind(id, text, A)))
  })
  it('an order or invoice code is found by its digits and by its parts', async () => {
    expect(await factsFound(A, '1187')).toEqual([CODE])
    expect(await factsFound(A, 'po 1187')).toEqual([CODE])
    expect(await factsFound(A, '"po 1187"')).toEqual([CODE])
    expect(await factsFound(A, 'PO-1187')).toEqual([CODE])
    expect(await factsFound(A, '4821')).toEqual([CODE])
    expect(await factsFound(A, '#4821')).toEqual([CODE])
  })
  it('known limit, accepted: porter merges a code with its trailing-s form (ABC123 and ABC123S find each other)', async () => {
    // A9's call (2026-11-22): OR-matching adds noise here but never loses a hit. The fix (an unstemmed index ranked
    // first) is in P9; when it lands, this test changes with it.
    expect(await factsFound(A, 'ABC123')).toEqual([SKU, SKU_S].sort())
    expect(await factsFound(A, 'ABC123S')).toEqual([SKU, SKU_S].sort())
  })
})

describe('the visibility rule holds under the wider matching (failure 5, the must-not)', () => {
  const FORMS = Object.values(FAMILIES).flat()
  test.prop([fc.constantFrom(A, B), fc.oneof(
    fc.array(fc.constantFrom(...FORMS), { minLength: 1, maxLength: 4 }).map(w => w.join(' ')),
    fc.array(fc.constantFrom(...FORMS), { minLength: 2, maxLength: 3 }).map(w => `"${w.join(' ')}"`),
  )], { numRuns: 40 })('a member never finds an item the seed record doesn\'t give them', async (who, query) => {
    for (const id of await factsFound(who, query)) expect(FACTS.find(f => f.id === id)!.seenBy, `${who} found ${id} with ${query}`).toContain(who)
    for (const id of await chatsFound(who, query)) expect(CHATS.find(c => c.id === id)!.seenBy, `${who} found ${id} with ${query}`).toContain(who)
  })
})
