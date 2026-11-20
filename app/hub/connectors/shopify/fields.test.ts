import { Kind, parse, type OperationDefinitionNode, type SelectionSetNode } from 'graphql'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { checkReadDocument } from '../../scope/graphql'
import { OPERATIONS, RECORDER_OPERATIONS, SHOPIFY_READ_SCOPES, TOOL_OPERATIONS } from './documents'
import { DENIED_FIELDS, DOCUMENT_FIELDS, ORDER_NOTE, RESULT_FIELDS } from './fields'
import { call, dataClient, fakeClient, MAXIMAL, TOOLS } from './test-kit'

// Test 5 of the brief's section 9 (Acceptance 3): the field lists, the denylist, the read-only document check and the
// scopes each document needs.

type Path = { path: string; leaf: boolean }

function walk(set: SelectionSetNode, prefix: string, out: Path[]) {
  for (const s of set.selections) {
    if (s.kind === Kind.INLINE_FRAGMENT) {
      walk(s.selectionSet, prefix, out)
      continue
    }
    if (s.kind !== Kind.FIELD) throw new Error('fragment spreads are not used in these documents')
    if (s.alias) throw new Error('aliases are not used in these documents')
    const p = prefix ? `${prefix}.${s.name.value}` : s.name.value
    out.push({ path: p, leaf: !s.selectionSet })
    if (s.selectionSet) walk(s.selectionSet, p, out)
  }
}

function documentPaths(document: string): Path[] {
  const ast = parse(document)
  const ops = ast.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
  expect(ops).toHaveLength(1)
  const out: Path[] = []
  walk(ops[0]!.selectionSet, '', out)
  return out
}

/** Leaf key paths of a zod parser (objects, arrays, nullables). */
function parserPaths(schema: z.ZodType, prefix = '', out: string[] = []): string[] {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) return parserPaths(schema.unwrap() as z.ZodType, prefix, out)
  if (schema instanceof z.ZodArray) return parserPaths(schema.element as z.ZodType, prefix, out)
  if (schema instanceof z.ZodObject) {
    for (const [k, v] of Object.entries(schema.shape)) parserPaths(v as z.ZodType, prefix ? `${prefix}.${k}` : k, out)
    return out
  }
  out.push(prefix)
  return out
}

function resultPaths(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) resultPaths(x, prefix, out)
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) resultPaths(x, prefix ? `${prefix}.${k}` : k, out)
  else out.add(prefix)
  return out
}

const sorted = (a: Iterable<string>) => [...a].sort()

describe('field lists', () => {
  it('every operation has a list and every list an operation', () => {
    expect(sorted(Object.keys(DOCUMENT_FIELDS))).toEqual(sorted(Object.keys(OPERATIONS)))
    expect(sorted(Object.keys(RESULT_FIELDS))).toEqual(sorted(Object.keys(TOOLS)))
  })

  for (const [op, document] of Object.entries(OPERATIONS)) {
    it(`${op}: the document selects exactly its list`, () => {
      expect(sorted(documentPaths(document).filter(p => p.leaf).map(p => p.path))).toEqual(sorted(DOCUMENT_FIELDS[op]!))
    })
  }

  for (const [name, spec] of Object.entries(TOOLS)) {
    it(`${name}: the parser reads exactly the document's list`, () => {
      expect(sorted(parserPaths(spec.parser))).toEqual(sorted(DOCUMENT_FIELDS[spec.operation]!))
    })

    it(`${name}: a maximal result has exactly its result list`, async () => {
      const { input, data } = MAXIMAL[name]!
      const r = await call(name, input, dataClient(data))
      if (!r.ok) throw new Error(r.error.code)
      expect(sorted(resultPaths(r.value))).toEqual(sorted(RESULT_FIELDS[name]!))
    })
  }

  it('the parser drops a field the document did not select', async () => {
    const data = structuredClone(MAXIMAL.orders_search!.data) as any
    data.orders.nodes[0].email = 'someone@example.com'
    data.orders.nodes[0].customer = { firstName: 'X' }
    const r = await call('orders_search', MAXIMAL.orders_search!.input, dataClient(data))
    expect(JSON.stringify(r)).not.toMatch(/someone@example|firstName/)
  })
})

describe('the denylist', () => {
  for (const [op, document] of Object.entries(OPERATIONS)) {
    it(`${op}: selects no level 2 field and no customer free text`, () => {
      for (const { path } of documentPaths(document)) {
        for (const segment of path.split('.')) expect(DENIED_FIELDS, `${op}: ${path}`).not.toContain(segment)
        expect(ORDER_NOTE.test(path), `${op}: ${path}`).toBe(false)
      }
    })
  }

  it('catches what it should', () => {
    expect(ORDER_NOTE.test('orders.nodes.note')).toBe(true)
    expect(ORDER_NOTE.test('orders.nodes.refunds.note')).toBe(false)
    expect(DENIED_FIELDS).toEqual(expect.arrayContaining(['customer', 'email', 'phone', 'shippingAddress', 'billingAddress', 'customerNote', 'returnReasonNote']))
  })
})

describe('read-only documents', () => {
  for (const [op, document] of Object.entries(OPERATIONS)) {
    it(`${op}: passes checkReadDocument with exactly one query operation`, () => {
      expect(checkReadDocument(document)).toEqual({ ok: true })
      const ops = parse(document).definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION)
      expect(ops.map(o => (o as OperationDefinitionNode).operation)).toEqual(['query'])
      expect((ops[0] as OperationDefinitionNode).name?.value).toBe(op)
    })
  }

  it('every tool document goes through the SignIn core path to the recorded upstream', async () => {
    const client = fakeClient()
    for (const [name, spec] of Object.entries(TOOLS)) {
      const r = await spec.tool.run({ shopify: client, scope: { kind: 'server', job: 'test', requestId: 'r' }, nowMs: 0 }, spec.tool.input.parse(MAXIMAL[name]!.input))
      expect(r.ok, name).toBe(true)
    }
  })

  it('every recorder document goes through the SignIn core path to the recorded upstream', async () => {
    const client = fakeClient()
    const variables: Record<string, Record<string, unknown>> = {
      RecordScopes: {},
      RecordOrders: { first: 5 },
      RecordRefunds: { first: 5, query: '(financial_status:"refunded" OR financial_status:"partially_refunded")' },
      RecordReturns: { first: 5, query: '-return_status:"no_return"' },
      RecordProducts: { first: 5 },
    }
    for (const [op, document] of Object.entries(RECORDER_OPERATIONS)) {
      const r = await client.graphql(document, variables[op])
      expect(r.ok, op).toBe(true)
    }
  })
})

/**
 * The scope each object a document reaches needs, from the docs (read 2026-11-20): access-scopes and each object's
 * "Requires" line. Objects that need none (MoneyBag, MoneyV2, PageInfo, Shop, AppInstallation) are listed as null.
 */
const SCOPE_OF: Record<string, string | null> = {
  orders: 'read_orders',
  'orders.nodes.lineItems': 'read_orders',
  'orders.nodes.refunds': 'read_orders',
  'orders.nodes.refunds.refundLineItems': 'read_orders',
  'orders.nodes.refunds.refundLineItems.nodes.lineItem': 'read_orders',
  'orders.nodes.returns': 'read_returns',
  'orders.nodes.returns.nodes.returnLineItems': 'read_returns',
  'orders.nodes.returns.nodes.returnLineItems.nodes.returnReasonDefinition': 'read_returns',
  'orders.nodes.returns.nodes.returnLineItems.nodes.fulfillmentLineItem': 'read_orders',
  'orders.nodes.returns.nodes.returnLineItems.nodes.fulfillmentLineItem.lineItem': 'read_orders',
  products: 'read_products',
  'products.nodes.variants': 'read_products',
  'products.nodes.variants.nodes.inventoryItem': 'read_inventory',
  'products.nodes.variants.nodes.inventoryItem.inventoryLevels': 'read_inventory',
  'products.nodes.variants.nodes.inventoryItem.inventoryLevels.nodes.location': 'read_locations',
  'products.nodes.variants.nodes.inventoryItem.inventoryLevels.nodes.quantities': 'read_inventory',
  productVariants: 'read_products',
  'productVariants.nodes.product': 'read_products',
  'productVariants.nodes.inventoryItem': 'read_inventory',
  'productVariants.nodes.inventoryItem.inventoryLevels': 'read_inventory',
  'productVariants.nodes.inventoryItem.inventoryLevels.nodes.location': 'read_locations',
  'productVariants.nodes.inventoryItem.inventoryLevels.nodes.quantities': 'read_inventory',
  shop: null,
  currentAppInstallation: null,
  'currentAppInstallation.accessScopes': null,
}
const FREE = /(^|\.)(nodes|pageInfo|shopMoney|currentTotalPriceSet|totalRefundedSet|originalUnitPriceSet)$/

describe('scopes', () => {
  for (const [op, document] of Object.entries(OPERATIONS)) {
    it(`${op}: every object it reaches needs only the five scopes`, () => {
      for (const { path, leaf } of documentPaths(document)) {
        if (leaf || FREE.test(path)) continue
        expect(Object.hasOwn(SCOPE_OF, path), `${op}: ${path} isn't in the scope table`).toBe(true)
        const scope = SCOPE_OF[path]
        if (scope !== null) expect(SHOPIFY_READ_SCOPES as readonly string[], `${op}: ${path}`).toContain(scope)
      }
    })
  }

  it('the tools between them need every one of the five', () => {
    const used = new Set<string>()
    for (const document of Object.values(TOOL_OPERATIONS)) {
      for (const { path, leaf } of documentPaths(document)) {
        const s = !leaf && !FREE.test(path) ? SCOPE_OF[path] : null
        if (s) used.add(s)
      }
    }
    expect(sorted(used)).toEqual(sorted(SHOPIFY_READ_SCOPES))
  })
})
