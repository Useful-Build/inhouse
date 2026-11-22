// The hand-written dataset (invented, forever: it drives every unit test and stays after the real recording).
// Each planted case once: a paid order unfulfilled for days (#1001), refunds with a note on one SKU (#1002, #1003 on
// HX-0062), an open return not processed (#1004 on HX-0089), a SKU near running out (HX-0013 at 29), an oversold SKU
// (HX-0038 at -4); plus a cancelled order (#1005), a USD shop, one order over every nested cap (#1006), one product
// over the variant cap and one variant over the level cap (Camp chair), and a title past its cap in multibyte text.
import { currentDocumentHashes } from '../../../../../hub/connectors/shopify/documents'

const usd = (amount: string) => ({ shopMoney: { amount, currencyCode: 'USD' } })
const order = (n: number) => `gid://shopify/Order/555000000${1000 + n}`
const line = (sku: string | null, title: string, qty: number, unfulfilled: number, price: string) => ({
  sku,
  title,
  currentQuantity: qty,
  unfulfilledQuantity: unfulfilled,
  originalUnitPriceSet: usd(price),
})
const refund = (createdAt: string, note: string | null, amount: string, lines: [string | null, number, string][]) => ({
  createdAt,
  note,
  totalRefundedSet: usd(amount),
  refundLineItems: { nodes: lines.map(([sku, quantity, restockType]) => ({ quantity, restockType, lineItem: { sku } })) },
})
const ret = (name: string, status: string, createdAt: string, lines: [string | null, number, number, string | null][]) => ({
  name,
  status,
  createdAt,
  returnLineItems: {
    nodes: lines.map(([sku, quantity, unprocessedQuantity, reason]) => ({
      quantity,
      unprocessedQuantity,
      returnReasonDefinition: reason === null ? null : { name: reason },
      fulfillmentLineItem: { lineItem: { sku } },
    })),
  },
})
const base = (n: number, processedAt: string, updatedAt: string) => ({
  id: order(n),
  name: `#${1000 + n}`,
  processedAt,
  updatedAt,
  cancelledAt: null as string | null,
})
const range = (k: number) => Array.from({ length: k }, (_, i) => i + 1)
const level = (name: string, available: number, onHand: number, committed: number, incoming: number) => ({
  location: { name },
  quantities: [
    { name: 'available', quantity: available },
    { name: 'on_hand', quantity: onHand },
    { name: 'committed', quantity: committed },
    { name: 'incoming', quantity: incoming },
  ],
})
const variant = (n: number, sku: string | null, title: string, price: string, levels: ReturnType<typeof level>[]) => ({
  id: `gid://shopify/ProductVariant/888000000${1000 + n}`,
  sku,
  title,
  price,
  inventoryItem: { tracked: true, inventoryLevels: { nodes: levels } },
})
const product = (n: number) => `gid://shopify/Product/777000000${1000 + n}`

export const LONG_TITLE = 'Çhâise de camp pliante ünïcode 折りたたみ椅子 🏕️ '.repeat(6).trim()

export const dataset: unknown = {
  v: 1,
  apiVersion: '2026-10',
  recordedOn: '2026-11-20',
  documentHashes: currentDocumentHashes(),
  currency: 'USD',
  orders: [
    {
      ...base(1, '2026-11-14T09:00:00Z', '2026-11-14T09:00:00Z'),
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'UNFULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('89.97'),
      totalRefundedSet: usd('0.00'),
      currentSubtotalLineItemsQuantity: 3,
      lineItems: { nodes: [line('HX-0013', 'Trail lantern', 2, 2, '24.99'), line('HX-0001', 'Tent stakes', 1, 1, '39.99')] },
      refunds: [],
      returns: { nodes: [] },
    },
    {
      ...base(2, '2026-11-12T10:30:00Z', '2026-11-19T10:00:00Z'),
      displayFinancialStatus: 'REFUNDED',
      displayFulfillmentStatus: 'FULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('0.00'),
      totalRefundedSet: usd('129.00'),
      currentSubtotalLineItemsQuantity: 0,
      lineItems: { nodes: [line('HX-0062', 'Camp stove, two burner', 0, 0, '129.00')] },
      refunds: [refund('2026-11-19T10:00:00Z', 'Igniter failed', '129.00', [['HX-0062', 1, 'NO_RESTOCK']])],
      returns: { nodes: [] },
    },
    {
      ...base(3, '2026-11-13T15:00:00Z', '2026-11-19T11:15:00Z'),
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      displayFulfillmentStatus: 'FULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('24.99'),
      totalRefundedSet: usd('129.00'),
      currentSubtotalLineItemsQuantity: 1,
      lineItems: { nodes: [line('HX-0062', 'Camp stove, two burner', 0, 0, '129.00'), line('HX-0013', 'Trail lantern', 1, 0, '24.99')] },
      refunds: [refund('2026-11-19T11:15:00Z', 'Igniter failed', '129.00', [['HX-0062', 1, 'NO_RESTOCK']])],
      returns: { nodes: [] },
    },
    {
      ...base(4, '2026-11-10T08:00:00Z', '2026-11-17T08:00:00Z'),
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      returnStatus: 'IN_PROGRESS',
      currentTotalPriceSet: usd('149.00'),
      totalRefundedSet: usd('0.00'),
      currentSubtotalLineItemsQuantity: 1,
      lineItems: { nodes: [line('HX-0089', 'Rain shell, medium', 1, 0, '149.00')] },
      refunds: [],
      returns: { nodes: [ret('#1004-R1', 'OPEN', '2026-11-17T08:00:00Z', [['HX-0089', 1, 1, 'Too small']])] },
    },
    {
      ...base(5, '2026-11-11T12:00:00Z', '2026-11-11T13:00:00Z'),
      cancelledAt: '2026-11-11T13:00:00Z',
      displayFinancialStatus: 'VOIDED',
      displayFulfillmentStatus: 'UNFULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('0.00'),
      totalRefundedSet: usd('0.00'),
      currentSubtotalLineItemsQuantity: 0,
      lineItems: { nodes: [line('HX-0038', 'Insulated mug', 0, 0, '18.50')] },
      refunds: [],
      returns: { nodes: [] },
    },
    {
      // Over every nested cap: 25 lines, 7 refunds of 7 lines, 7 returns of 7 lines.
      ...base(6, '2026-11-08T07:45:00Z', '2026-11-18T16:00:00Z'),
      displayFinancialStatus: 'PARTIALLY_REFUNDED',
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      returnStatus: 'RETURN_REQUESTED',
      currentTotalPriceSet: usd('1234.56'),
      totalRefundedSet: usd('70.00'),
      currentSubtotalLineItemsQuantity: 25,
      lineItems: { nodes: range(25).map(i => line(`HX-1${String(i).padStart(3, '0')}`, `Bulk item ${i}`, 1, i % 2, '9.99')) },
      refunds: range(7).map(r =>
        refund(`2026-11-18T1${r}:00:00Z`, `Bulk refund ${r}`, '10.00', range(7).map(i => [`HX-1${String(i).padStart(3, '0')}`, 1, 'RETURN'])),
      ),
      returns: {
        nodes: range(7).map(r =>
          ret(`#1006-R${r}`, 'REQUESTED', `2026-11-18T0${r}:30:00Z`, range(7).map(i => [`HX-1${String(i).padStart(3, '0')}`, 1, 1, i % 2 ? 'Changed mind' : null])),
        ),
      },
    },
    {
      ...base(7, '2026-11-15T18:20:00Z', '2026-11-16T09:00:00Z'),
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('55.50'),
      totalRefundedSet: usd('0.00'),
      currentSubtotalLineItemsQuantity: 3,
      lineItems: { nodes: [line('HX-0038', 'Insulated mug', 3, 0, '18.50')] },
      refunds: [],
      returns: { nodes: [] },
    },
    {
      ...base(8, '2026-11-16T11:05:00Z', '2026-11-16T11:05:00Z'),
      displayFinancialStatus: 'PAID',
      displayFulfillmentStatus: 'FULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('124.95'),
      totalRefundedSet: usd('0.00'),
      currentSubtotalLineItemsQuantity: 5,
      lineItems: { nodes: [line('HX-0013', 'Trail lantern', 5, 0, '24.99')] },
      refunds: [],
      returns: { nodes: [] },
    },
    {
      ...base(9, '2026-11-16T11:05:00Z', '2026-11-16T12:00:00Z'),
      displayFinancialStatus: 'PENDING',
      displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
      returnStatus: 'NO_RETURN',
      currentTotalPriceSet: usd('64.98'),
      totalRefundedSet: usd('0.00'),
      currentSubtotalLineItemsQuantity: 2,
      lineItems: { nodes: [line(null, 'Gift card', 1, 1, '40.00'), line('HX-0013', 'Trail lantern', 1, 0, '24.99')] },
      refunds: [],
      returns: { nodes: [] },
    },
  ],
  products: [
    {
      id: product(1),
      title: 'Camp stove, two burner',
      status: 'ACTIVE',
      totalInventory: 12,
      tracksInventory: true,
      variants: { nodes: [variant(1, 'HX-0062', 'Default Title', '129.00', [level('Warehouse', 12, 12, 0, 0)])] },
    },
    {
      id: product(2),
      title: 'Trail lantern',
      status: 'ACTIVE',
      totalInventory: 29,
      tracksInventory: true,
      variants: { nodes: [variant(2, 'HX-0013', 'Default Title', '24.99', [level('Warehouse', 29, 31, 2, 40)])] },
    },
    {
      id: product(3),
      title: 'Insulated mug',
      status: 'ACTIVE',
      totalInventory: -4,
      tracksInventory: true,
      variants: { nodes: [variant(3, 'HX-0038', 'Default Title', '18.50', [level('Warehouse', -4, 0, 4, 0)])] },
    },
    {
      id: product(4),
      title: 'Rain shell',
      status: 'DRAFT',
      totalInventory: 60,
      tracksInventory: true,
      variants: {
        nodes: [
          variant(4, 'HX-0089', 'Medium', '149.00', [level('Warehouse', 15, 15, 0, 0)]),
          variant(5, 'HX-0089-S', 'Small', '149.00', [level('Warehouse', 15, 15, 0, 0)]),
          variant(6, 'HX-0089-L', 'Large', '149.00', [level('Warehouse', 15, 15, 0, 0)]),
          variant(7, 'HX-0089-XL', 'Extra large', '149.00', [level('Warehouse', 15, 15, 0, 0)]),
        ],
      },
    },
    {
      id: product(5),
      title: LONG_TITLE,
      status: 'ARCHIVED',
      totalInventory: 0,
      tracksInventory: false,
      variants: {
        nodes: [
          variant(
            8,
            'HX-0100',
            'Ünïcode variant title that runs well past the sixty byte cap, ünïcode',
            '0.99',
            range(12).map(i => level(`Store ${i}`, 0, 0, 0, 0)),
          ),
        ],
      },
    },
  ],
}
