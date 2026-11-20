// What memory refuses (p3-design section 10). Ways it can fail, written down first: an email, a US or UK phone, a card
// number or a street address saved; a plain business fact refused (a day, a date, a promo, a sort order, a lead time).
// Literal fixtures only; the refusal must also reach the agent through the tools, and write nothing.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { personalDataIn } from './personal-data.ts'
import { memoryStore } from './store.ts'

const REFUSED: [string, 'email' | 'phone' | 'card' | 'address'][] = [
  ['Mei at Kestrel is mei.chen@kestrel-supply.example', 'email'],
  ['Send returns questions to returns+uk@shop.example.co.uk', 'email'],
  ['Call the customer back on (415) 555-0123', 'phone'],
  ['US wholesale line: +1 415 555 0123', 'phone'],
  ['Her number is 415.555.0123', 'phone'],
  ['UK customer phone 020 7946 0958', 'phone'],
  ['UK mobile +44 7700 900123', 'phone'],
  ['Mobile 07700900123 prefers texts', 'phone'],
  ['Card on file 4111 1111 1111 1111', 'card'],
  ['Refund to 4111-1111-1111-1111', 'card'],
  ['Amex 378282246310005 for the deposit', 'card'],
  ['Ship her order to 221B Baker Street', 'address'],
  ['Deliver to 1600 Pennsylvania Avenue for the event', 'address'],
  ['Customer lives at 42 Wallaby Way', 'address'],
  ['Return label for 10 Downing St', 'address'],
  ['Collect from the depot, SW1A 1AA', 'address'],
  ['Send it to 10 Downing Street, London SW1A 2AA', 'address'],
  ['Her flat is 7 Park Lane', 'address'],
]
const ACCEPTED = [
  'We restock on Fridays',
  'Sort order tables by date',
  'The March 3 promo ran for a week',
  'Kestrel Supply ships in 14 days',
  'Restocking fee is 15 percent',
  'The 2026-11-03 price change applies to all SKUs',
  'Minimum order is 250 units',
  'Our busiest month is December, with 3 times the orders',
  'Sam prefers short supplier emails',
  'Use 2 decimal places in reports',
  // Opus L6: ordinary facts the earlier street and postcode patterns refused.
  'Pack 2 items the same way',
  'Size M2 3XL runs small',
  'Orders over 100 units take first place',
  'Ship 3 pallets to the close',
  'Restock 4 units every week, the same way',
]

describe('personalDataIn', () => {
  it('finds each kind in the literal examples', () => {
    for (const [text, kind] of REFUSED) expect(personalDataIn(text), text).toBe(kind)
  })
  it('lets plain business facts through', () => {
    for (const text of ACCEPTED) expect(personalDataIn(text), text).toBeNull()
  })
})

describe('the store refuses on save and update, with a reason, and writes nothing', () => {
  const db = env.DB
  const store = memoryStore({ db })
  it('save and update', async () => {
    await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES ('m_pd', 'person', 'member', 'active', 'Pat', 1)").run()
    const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM memories').first<number>('n'))!
    const before = await count()
    for (const [text, kind] of REFUSED) {
      expect(await store.save({ memberId: 'm_pd', scope: 'person', text, chatId: null, nowMs: 1, requestId: 'r' }), text).toEqual({ refused: 'personal_data', kind })
    }
    expect(await count()).toBe(before)
    const saved = await store.save({ memberId: 'm_pd', scope: 'person', text: ACCEPTED[1], chatId: null, nowMs: 1, requestId: 'r' })
    if (!('saved' in saved)) throw new Error(`not saved: ${JSON.stringify(saved)}`)
    expect(await store.update({ memberId: 'm_pd', id: saved.saved.id, text: 'Sort by date, call 020 7946 0958 first', nowMs: 2, requestId: 'r' })).toEqual({ refused: 'personal_data', kind: 'phone' })
    expect((await store.byId(saved.saved.id))?.text).toBe(ACCEPTED[1])
  })
})
