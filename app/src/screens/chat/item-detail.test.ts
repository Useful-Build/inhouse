// A row with the store's facts (Stage 1 M3 card details, PR 555, issue 578). Ways it could break, written first:
//  - the record shows the order's id with a `#` (reads as the shop's order number) when the store gave its real name;
//  - the customer or the total is missing, or the change the person approves drops out of the row;
//  - a part of a list, a deleted order or product, or a note-only detail reads as something else;
//  - a draft order's row names variants by id when the products were read.
import { describe, expect, test } from 'vitest'
import { detailRows, detailWords, NOT_IN_STORE, rowView } from './item-detail'

/** An order's name ("#" and its number), built so no literal reads as a colour to the token check. */
const name = (n: number) => `#${n}`
const row = { ref: 'Order 9001', change: 'add VIP' }
const order = (n: number, o: Record<string, unknown> = {}) => ({ ref: `Order ${n}`, order: name(3900 + n - 9000), customer: 'Alex Moore', amount: '$642.10', currency: 'USD', ...o })

describe('rowView', () => {
  test('no detail: the server row as it is', () => {
    expect(rowView(row)).toEqual({ ref: 'Order 9001', main: 'add VIP' })
    expect(rowView({ ...row, amount: '+20' }, null)).toEqual({ ref: 'Order 9001', main: 'add VIP', amount: '+20' })
  })
  test('one order: its name, its customer, the change under it, and its total', () => {
    expect(rowView(row, { rows: [order(9001)] })).toEqual({ ref: name(3901), main: 'Alex Moore', sub: 'add VIP', amount: '$642.10' })
  })
  test('a guest order keeps the change as its main words; a deleted order says so', () => {
    expect(rowView(row, { rows: [order(9001, { customer: undefined })] })).toEqual({ ref: name(3901), main: 'add VIP', amount: '$642.10' })
    expect(rowView(row, { rows: [{ ref: 'Order 9001', notFound: true }] })).toEqual({ ref: 'Order 9001', main: NOT_IN_STORE, sub: 'add VIP' })
  })
  test('several orders in one item: every name and customer, no single total', () => {
    const v = rowView({ ref: 'Orders 9001, 9002', change: 'add VIP' }, { rows: [order(9001), order(9002, { customer: 'Priya Shah', amount: '$1,208.00' })] })
    expect(v).toEqual({ ref: `${name(3901)}, ${name(3902)}`, main: 'Alex Moore, Priya Shah', sub: 'add VIP' })
  })
  test('a draft order names its products; a deleted one and the server row stay visible', () => {
    const draft = { ref: '', change: '2 × variant 7001, 1 × variant 7009' }
    expect(rowView(draft, { rows: [{ ref: 'Variant 7001', product: 'Linen shirt, M', sku: 'LIN-M', quantity: 2 }, { ref: 'Variant 7009', quantity: 1, notFound: true }] }))
      .toEqual({ ref: '', main: '2 × Linen shirt, M, 1 × Variant 7009 (not in the store now)', sub: '2 × variant 7001, 1 × variant 7009' })
  })
  test('a note with no rows is said quietly under the row', () => {
    expect(rowView({ ref: '', change: '2 × variant 7001' }, { rows: [], note: 'Product names couldn’t be read.' }))
      .toEqual({ ref: '', main: '2 × variant 7001', note: 'Product names couldn’t be read.' })
  })
})

describe('a single card\'s rows and the search words', () => {
  test('one row per order or line', () => {
    expect(detailRows({ rows: [order(9001)] })).toEqual([{ ref: name(3901), main: 'Alex Moore', amount: '$642.10' }])
    expect(detailRows({ rows: [{ ref: 'Variant 7001', product: 'Linen shirt, M', sku: 'LIN-M', quantity: 2 }] })).toEqual([{ ref: '', main: '2 × Linen shirt, M', sub: 'LIN-M' }])
  })
  test('the search reads names, customers and products', () => {
    expect(detailWords({ rows: [order(9001), { ref: 'Variant 7001', product: 'Linen shirt, M', sku: 'LIN-M', quantity: 1 }] }))
      .toEqual([name(3901), 'Alex Moore', 'Linen shirt, M', 'LIN-M'])
    expect(detailWords(undefined)).toEqual([])
  })
})
