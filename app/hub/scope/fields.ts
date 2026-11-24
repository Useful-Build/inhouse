// The level 1 field and argument check for every Shopify document (P5 W2, A.3a). Runs in SignIn.query right after the
// read-only check and before any token is opened, so no caller (code mode or the six tools) can skip it.
//
// An allowlist, not a denylist: a field Shopify adds later, or a level 2 field on an app that holds level 2, is refused
// without anyone listing it. Every rule is keyed on the field's name and path, never its alias.
// - Paths: fragments are inlined (named spreads by name, a cycle or more than 20 nested spreads refused; inline
//   fragments' type conditions change nothing). `__typename` is skipped anywhere; any other `__` name (introspection)
//   is refused; `edges` and `node` are refused (only `nodes` and `pageInfo`). Every path from the root must be a prefix
//   of an allowed path, and every leaf must be an allowed path exactly. DENIED_FIELDS and ORDER_NOTE apply on top.
// - Arguments: a root connection takes first, after, reverse, query, sortKey; a nested selection first, after; the
//   tools' one other argument (`quantities(names:)`, inventory_levels_get) only the recorded quantity names; anything
//   else none. Values are checked whether literal or passed as variables: `query` by the search grammar and its keys
//   per root (search-query.ts), `sortKey` by a fixed table. A variable the operation doesn't declare is refused.
// - At most 3 root fields (aliased fan-out per call).
// - Directives: `@include` and `@skip` only.
import { Kind, parse, type DocumentNode, type FieldNode, type FragmentDefinitionNode, type OperationDefinitionNode, type SelectionSetNode, type ValueNode } from 'graphql'
import { QUANTITY_NAMES } from '../connectors/shopify/documents'
import { DENIED_FIELDS, DOCUMENT_FIELDS, ORDER_NOTE } from '../connectors/shopify/fields'
import { parseSearchQuery, type SearchRoot } from './search-query'

/** The union of every tool and recorder document's leaf paths. */
export const ALLOWED_PATHS: ReadonlySet<string> = new Set(Object.values(DOCUMENT_FIELDS).flat())

/** Every proper prefix of an allowed path: the paths a field with a selection set may sit on. */
const PREFIXES: ReadonlySet<string> = new Set(
  [...ALLOWED_PATHS].flatMap(p => {
    const parts = p.split('.')
    return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('.'))
  }),
)

/** The sort keys the tools' and recorder's documents use, per root. Anything else (CUSTOMER_NAME...) is refused. */
export const SORT_KEYS: Readonly<Record<string, readonly string[]>> = {
  orders: ['PROCESSED_AT', 'UPDATED_AT', 'ID'],
  products: ['TITLE', 'INVENTORY_TOTAL', 'ID'],
}

export const CONNECTION_ROOTS: readonly SearchRoot[] = ['orders', 'products', 'productVariants']
export const MAX_ROOT_FIELDS = 3
export const MAX_SPREAD_DEPTH = 20
/** Fields visited after inlining; bounds a document whose fragments fan out exponentially. */
export const MAX_VISITS = 10_000
export const MAX_FIRST = 250
const MAX_CURSOR = 1_000
const QUANTITIES_PATH = /\.inventoryLevels\.nodes\.quantities$/
const DENIED = new Set(DENIED_FIELDS)

/** The fixed detail SignIn.query answers with (`invalid_args: field not allowed`). */
export const FIELD_NOT_ALLOWED = 'field not allowed'

export type FieldCheck = { ok: true } | { ok: false }

class Refused extends Error {}
const refuse = (): never => {
  throw new Refused()
}

type Walk = {
  fragments: Map<string, FragmentDefinitionNode>
  declared: Map<string, ValueNode | undefined>
  variables: Record<string, unknown>
  visits: number
}

/** Refused unless every field, argument, `query` key and sort key in the one operation is on the allowlist. */
export function checkShopifyFields(document: string | DocumentNode, variables: Record<string, unknown> = {}): FieldCheck {
  try {
    const ast = typeof document === 'string' ? parse(document, { noLocation: true }) : document
    const ops = ast.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
    if (ops.length !== 1 || ops[0]!.operation !== 'query') return { ok: false }
    const op = ops[0]!
    const w: Walk = { fragments: new Map(), declared: new Map(), variables, visits: 0 }
    for (const d of ast.definitions) {
      if (d.kind === Kind.FRAGMENT_DEFINITION) {
        if (w.fragments.has(d.name.value)) refuse()
        w.fragments.set(d.name.value, d)
      }
    }
    for (const v of op.variableDefinitions ?? []) w.declared.set(v.variable.name.value, v.defaultValue)
    // A variable the operation doesn't declare would still be sent upstream: refused.
    for (const name of Object.keys(variables)) if (!w.declared.has(name)) return { ok: false }
    checkDirectives(op.directives)
    const roots = { count: 0 }
    selections(w, op.selectionSet, [], [], roots)
    return { ok: true }
  } catch {
    // A parse error, a refusal, or anything unexpected: refused (fail closed).
    return { ok: false }
  }
}

function checkDirectives(directives: readonly { name: { value: string } }[] | undefined): void {
  for (const d of directives ?? []) if (d.name.value !== 'include' && d.name.value !== 'skip') refuse()
}

function selections(w: Walk, set: SelectionSetNode, path: string[], spreads: string[], roots: { count: number }): void {
  for (const s of set.selections) {
    checkDirectives(s.directives)
    if (s.kind === Kind.FIELD) field(w, s, path, spreads, roots)
    else if (s.kind === Kind.INLINE_FRAGMENT) selections(w, s.selectionSet, path, spreads, roots)
    else {
      const name = s.name.value
      if (spreads.includes(name) || spreads.length >= MAX_SPREAD_DEPTH) refuse()
      const f = w.fragments.get(name) ?? refuse()
      checkDirectives(f.directives)
      selections(w, f.selectionSet, path, [...spreads, name], roots)
    }
  }
}

function field(w: Walk, f: FieldNode, path: string[], spreads: string[], roots: { count: number }): void {
  if (++w.visits > MAX_VISITS) refuse()
  // The field's own name; the alias never matters.
  const name = f.name.value
  if (name === '__typename') {
    if ((f.arguments ?? []).length > 0 || f.selectionSet) refuse()
    return
  }
  if (name.startsWith('__') || name === 'edges' || name === 'node' || DENIED.has(name)) refuse()
  const here = [...path, name]
  const p = here.join('.')
  if (ORDER_NOTE.test(p)) refuse()
  if (path.length === 0 && ++roots.count > MAX_ROOT_FIELDS) refuse()
  if (f.selectionSet) {
    if (!PREFIXES.has(p)) refuse()
  } else if (!ALLOWED_PATHS.has(p)) refuse()
  args(w, f, path, p)
  if (f.selectionSet) selections(w, f.selectionSet, here, spreads, roots)
}

function args(w: Walk, f: FieldNode, path: string[], p: string): void {
  const list = f.arguments ?? []
  if (list.length === 0) return
  const name = f.name.value
  const root = path.length === 0
  const connectionRoot = root && (CONNECTION_ROOTS as readonly string[]).includes(name)
  const seen = new Set<string>()
  for (const a of list) {
    const arg = a.name.value
    if (seen.has(arg)) refuse()
    seen.add(arg)
    const value = resolve(w, a.value)
    if (connectionRoot && ['first', 'after', 'reverse', 'query', 'sortKey'].includes(arg)) rootArg(name as SearchRoot, arg, value)
    else if (!root && f.selectionSet && (arg === 'first' || arg === 'after')) rootArg(null, arg, value)
    else if (!root && arg === 'names' && QUANTITIES_PATH.test(p)) {
      if (!Array.isArray(value) || value.some(n => typeof n !== 'string' || !(QUANTITY_NAMES as readonly string[]).includes(n))) refuse()
    } else refuse()
  }
}

function rootArg(root: SearchRoot | null, arg: string, value: unknown): void {
  if (value === undefined) return
  switch (arg) {
    case 'first':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_FIRST) refuse()
      return
    case 'after':
      if (value !== null && (typeof value !== 'string' || value.length > MAX_CURSOR)) refuse()
      return
    case 'reverse':
      if (value !== null && typeof value !== 'boolean') refuse()
      return
    case 'query':
      if (value !== null && (typeof value !== 'string' || parseSearchQuery(root!, value) === null)) refuse()
      return
    case 'sortKey':
      if (value !== null && (typeof value !== 'string' || !(SORT_KEYS[root!] ?? []).includes(value))) refuse()
      return
  }
  refuse()
}

/** A literal's value, or a variable's (from `variables`, else its default, else undefined: the argument is omitted). */
function resolve(w: Walk, v: ValueNode): unknown {
  switch (v.kind) {
    case Kind.VARIABLE: {
      const name = v.name.value
      if (!w.declared.has(name)) refuse()
      if (Object.hasOwn(w.variables, name)) return w.variables[name]
      const fallback = w.declared.get(name)
      return fallback === undefined ? undefined : resolve(w, fallback)
    }
    case Kind.INT:
      return Number(v.value)
    case Kind.FLOAT:
      return Number(v.value)
    case Kind.STRING:
      return v.value
    case Kind.BOOLEAN:
      return v.value
    case Kind.NULL:
      return null
    case Kind.ENUM:
      return v.value
    case Kind.LIST:
      return v.values.map(x => resolve(w, x))
    case Kind.OBJECT:
      // No allowed argument takes an input object.
      return refuse()
  }
}
