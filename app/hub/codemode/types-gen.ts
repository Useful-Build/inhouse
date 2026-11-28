// Pure TypeScript declaration generator for code-mode tools (Stage 1 M4-K2, N43, N44, N47, N53).
// Zero runtime dependencies: turns MCP tool input/output JSON Schemas into `declare const tools` TypeScript
// declarations. All schema text (descriptions, property names, enum values, server/tool names) is untrusted:
// JSDoc comments cannot be closed early, non-identifier property names are safely quoted, and anything malformed or
// past bounds degrades to `unknown` without throwing.

export const MAX_SCHEMA_BYTES = 16 * 1024
export const MAX_SCHEMA_DEPTH = 8
export const MAX_SCHEMA_PROPERTIES = 200
export const MAX_REF_DEPTH = 8
export const MAX_REF_EXPANSIONS = 200
export const MAX_NODE_VISITS = 2_000
export const MAX_ENUM_VALUES = 200
export const MAX_TOOL_DESCRIPTION_CHARS = 1024
export const MAX_NESTED_DESCRIPTION_CHARS = 200
export const MAX_TOOLS_COUNT = 20

export type ToolSchemaDescriptor = {
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly mode?: 'read' | 'write'
  readonly inputSchema: unknown
  readonly outputSchema?: unknown
}

export type TypesGenOptions = {
  readonly maxTools?: number
  readonly maxSchemaBytes?: number
  readonly maxDepth?: number
  readonly maxProperties?: number
  readonly maxRefDepth?: number
  readonly maxToolDescriptionChars?: number
  readonly maxNestedDescriptionChars?: number
}

type ResolvedOptions = {
  maxTools: number
  maxSchemaBytes: number
  maxDepth: number
  maxProperties: number
  maxRefDepth: number
  maxToolDescriptionChars: number
  maxNestedDescriptionChars: number
}

type TypeExpr = { ts: string; isUnion: boolean }

type GenState = {
  root: unknown
  opts: ResolvedOptions
  properties: number
  refExpansions: number
  nodes: number
  activeRefs: Set<string>
}

const VALID_ASCII_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const RESERVED_IDENTIFIERS = new Set([
  // JS reserved & strict-mode keywords
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
  'implements', 'interface', 'let', 'package', 'private', 'protected', 'public', 'static', 'yield', 'await',
  // TS keywords & special property names
  'any', 'as', 'asserts', 'async', 'boolean', 'constructor', 'declare', 'from', 'get', 'infer', 'is', 'keyof',
  'module', 'namespace', 'never', 'number', 'object', 'of', 'override', 'readonly', 'require', 'satisfies',
  'set', 'string', 'symbol', 'type', 'undefined', 'unknown', 'using', 'accessor',
  '__proto__', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
])

const FORBIDDEN_POINTER_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

function clampLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function resolveOptions(options?: TypesGenOptions): ResolvedOptions {
  return {
    maxTools: clampLimit(options?.maxTools, MAX_TOOLS_COUNT),
    maxSchemaBytes: clampLimit(options?.maxSchemaBytes, MAX_SCHEMA_BYTES),
    maxDepth: clampLimit(options?.maxDepth, MAX_SCHEMA_DEPTH),
    maxProperties: clampLimit(options?.maxProperties, MAX_SCHEMA_PROPERTIES),
    maxRefDepth: clampLimit(options?.maxRefDepth, MAX_REF_DEPTH),
    maxToolDescriptionChars: clampLimit(options?.maxToolDescriptionChars, MAX_TOOL_DESCRIPTION_CHARS),
    maxNestedDescriptionChars: clampLimit(options?.maxNestedDescriptionChars, MAX_NESTED_DESCRIPTION_CHARS),
  }
}

function wellFormed(text: string): string {
  const fn = (text as { toWellFormed?: () => string }).toWellFormed
  return typeof fn === 'function' ? fn.call(text) : text
}

/**
 * Escapes untrusted text for placement inside a `/** ... * /` JSDoc comment.
 * Strips/normalizes line terminators, control chars, bidi overrides and backticks, neutralizes comment
 * openers/closers (`/*` and `* /`), and caps length without splitting surrogate pairs.
 */
export function escapeJsDoc(text: string, maxLength: number = MAX_TOOL_DESCRIPTION_CHARS): string {
  if (typeof text !== 'string') return ''
  const limit = clampLimit(maxLength, MAX_TOOL_DESCRIPTION_CHARS)
  if (limit === 0 || text.length === 0) return ''

  let out = wellFormed(text)
    // Normalize all line/paragraph breaks and tabs to spaces so JSDoc stays single-line and cannot forge tags.
    .replace(/[\r\n\t\u0085\u2028\u2029]+/g, ' ')
    // Strip remaining C0/C1 controls and Unicode bidi/directionality controls.
    .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    // Replace backticks so declarations embedded in template literals or markdown code fences cannot break out.
    .replace(/`/g, "'")
    // Neutralize comment openers and closers. Loop so neither `/*` nor `*/` can survive or appear via interaction.
    .replace(/\/\*/g, '/ *')
    .replace(/\*\//g, '* /')
    .trim()

  while (out.includes('*/') || out.includes('/*')) {
    out = out.replace(/\/\*/g, '/ *').replace(/\*\//g, '* /')
  }

  if (out.length > limit) {
    let cut = limit
    // Avoid splitting a UTF-16 surrogate pair at the boundary.
    const lastCode = out.charCodeAt(cut - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut--
    out = out.slice(0, cut).trimEnd()
  }
  return out
}

/** Quotes a string as a single-line, TypeScript-safe string literal with no raw backticks or line separators. */
function safeStringLiteral(value: string): string {
  return JSON.stringify(wellFormed(value)).replace(
    /[`\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

export function isValidIdentifier(name: string): boolean {
  return typeof name === 'string' && VALID_ASCII_IDENT.test(name) && !RESERVED_IDENTIFIERS.has(name)
}

/** Formats a property, server, or tool name safely for TypeScript object type literals. */
export function formatPropertyName(name: string): string {
  if (typeof name !== 'string') return '""'
  return isValidIdentifier(name) ? name : safeStringLiteral(name)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function safeGet(obj: Record<string, unknown>, key: string): unknown {
  if (!Object.hasOwn(obj, key)) return undefined
  return obj[key]
}

function safeEntries(obj: Record<string, unknown>): [string, unknown][] {
  const keys = Object.keys(obj)
  const out: [string, unknown][] = []
  for (const k of keys) out.push([k, obj[k]])
  return out
}

const textEncoder = new TextEncoder()

/**
 * Measures approximate JSON byte size of `value` with cycle detection and early exit once `maxBytes` is exceeded.
 * Returns `false` if cyclic, over `maxBytes`, over `MAX_NODE_VISITS * 4`, or if any getter/Proxy throws.
 */
function fitsWithinByteBound(value: unknown, maxBytes: number): boolean {
  let bytes = 0
  let nodes = 0
  const maxNodes = Math.max(256, maxBytes)
  const seen = new Set<object>()

  const add = (n: number): boolean => {
    bytes += n
    return bytes <= maxBytes
  }

  const walk = (v: unknown): boolean => {
    if (++nodes > maxNodes) return false
    if (v === null) return add(4)
    switch (typeof v) {
      case 'boolean':
        return add(v ? 4 : 5)
      case 'number':
        return Number.isFinite(v) ? add(String(v).length) : add(4)
      case 'string': {
        // Quick lower bound before UTF-8 encoding a potentially multi-megabyte string.
        if (v.length + 2 + bytes > maxBytes) return false
        return add(textEncoder.encode(v).byteLength + 2)
      }
      case 'undefined':
        return add(4)
      case 'object': {
        const obj = v as object
        if (seen.has(obj)) return false
        seen.add(obj)
        try {
          if (Array.isArray(v)) {
            if (!add(2)) return false
            for (let i = 0; i < v.length; i++) {
              if (i > 0 && !add(1)) return false
              if (!walk(v[i])) return false
            }
            return true
          }
          if (!isPlainRecord(v)) return false
          if (!add(2)) return false
          const keys = Object.keys(v)
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i]!
            if (i > 0 && !add(1)) return false
            if (k.length + 3 + bytes > maxBytes) return false
            if (!add(textEncoder.encode(k).byteLength + 3)) return false
            if (!walk(v[k])) return false
          }
          return true
        } finally {
          seen.delete(obj)
        }
      }
      default:
        return false
    }
  }

  try {
    return walk(value)
  } catch {
    return false
  }
}

function literalToType(value: unknown, depth: number, indent: number, state: GenState): TypeExpr {
  if (depth > state.opts.maxDepth || ++state.nodes > MAX_NODE_VISITS) return { ts: 'unknown', isUnion: false }
  if (value === null) return { ts: 'null', isUnion: false }
  switch (typeof value) {
    case 'string':
      return { ts: safeStringLiteral(value), isUnion: false }
    case 'number':
      if (!Number.isFinite(value)) return { ts: 'number', isUnion: false }
      return { ts: Object.is(value, -0) ? '0' : String(value), isUnion: false }
    case 'boolean':
      return { ts: value ? 'true' : 'false', isUnion: false }
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length > state.opts.maxProperties) return { ts: 'unknown', isUnion: false }
        const elems = value.map(item => literalToType(item, depth + 1, indent + 1, state).ts)
        return { ts: `[${elems.join(', ')}]`, isUnion: false }
      }
      if (!isPlainRecord(value)) return { ts: 'unknown', isUnion: false }
      const entries = safeEntries(value)
      if (state.properties + entries.length > state.opts.maxProperties) return { ts: 'unknown', isUnion: false }
      state.properties += entries.length
      if (entries.length === 0) return { ts: 'Record<string, never>', isUnion: false }
      const pad = '  '.repeat(indent + 1)
      const closePad = '  '.repeat(indent)
      const lines: string[] = []
      const seenKeys = new Set<string>()
      for (const [k, v] of entries) {
        const keyTs = formatPropertyName(k)
        if (seenKeys.has(keyTs)) continue
        seenKeys.add(keyTs)
        lines.push(`${pad}${keyTs}: ${literalToType(v, depth + 1, indent + 1, state).ts};`)
      }
      return { ts: `{\n${lines.join('\n')}\n${closePad}}`, isUnion: false }
    }
    default:
      return { ts: 'unknown', isUnion: false }
  }
}

function resolveLocalRef(root: unknown, ref: string): { found: true; value: unknown } | { found: false } {
  if (ref === '#') return { found: true, value: root }
  if (!ref.startsWith('#/')) return { found: false }
  const segments = ref.slice(2).split('/')
  let cur: unknown = root
  for (const rawSeg of segments) {
    let decoded = rawSeg
    if (decoded.includes('%')) {
      try {
        decoded = decodeURIComponent(decoded)
      } catch {
        return { found: false }
      }
    }
    const key = decoded.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(cur)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key)) return { found: false }
      const idx = Number(key)
      if (idx >= cur.length) return { found: false }
      cur = cur[idx]
      continue
    }
    if (!isPlainRecord(cur)) return { found: false }
    if (FORBIDDEN_POINTER_SEGMENTS.has(key) || !Object.hasOwn(cur, key)) return { found: false }
    cur = cur[key]
  }
  return { found: true, value: cur }
}

function dedupeTypes(exprs: readonly TypeExpr[]): TypeExpr[] {
  const seen = new Set<string>()
  const out: TypeExpr[] = []
  for (const e of exprs) {
    if (!seen.has(e.ts)) {
      seen.add(e.ts)
      out.push(e)
    }
  }
  return out
}

function joinUnion(exprs: readonly TypeExpr[]): TypeExpr {
  const unique = dedupeTypes(exprs)
  if (unique.length === 0) return { ts: 'never', isUnion: false }
  if (unique.length === 1) return unique[0]!
  return { ts: unique.map(e => e.ts).join(' | '), isUnion: true }
}

function joinIntersection(exprs: readonly TypeExpr[]): TypeExpr {
  const filtered = dedupeTypes(exprs)
  if (filtered.length === 0) return { ts: 'unknown', isUnion: false }
  const nonUnknown = filtered.filter(e => e.ts !== 'unknown')
  const list = nonUnknown.length > 0 ? nonUnknown : filtered
  if (list.length === 1) return list[0]!
  return {
    ts: list.map(e => (e.isUnion ? `(${e.ts})` : e.ts)).join(' & '),
    isUnion: false,
  }
}

function applyNullable(expr: TypeExpr, nullable: unknown): TypeExpr {
  if (nullable !== true) return expr
  if (expr.ts === 'null' || expr.ts === 'unknown' || expr.ts === 'never') return expr
  return joinUnion([expr, { ts: 'null', isUnion: false }])
}

function descriptionOf(schema: unknown, maxLength: number): string | null {
  if (!isPlainRecord(schema)) return null
  const raw = safeGet(schema, 'description')
  if (typeof raw !== 'string') return null
  const escaped = escapeJsDoc(raw, maxLength)
  return escaped.length > 0 ? escaped : null
}

function formatObjectType(obj: Record<string, unknown>, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  const rawProps = safeGet(obj, 'properties')
  const hasPropsObj = isPlainRecord(rawProps)
  const propEntries = hasPropsObj ? safeEntries(rawProps) : []

  if (state.properties + propEntries.length > state.opts.maxProperties) {
    return { ts: 'unknown', isUnion: false }
  }
  state.properties += propEntries.length

  const rawRequired = safeGet(obj, 'required')
  const required = new Set<string>()
  if (Array.isArray(rawRequired)) {
    for (const item of rawRequired) {
      if (typeof item === 'string') required.add(item)
    }
  }

  const additional = safeGet(obj, 'additionalProperties')
  const pad = '  '.repeat(indent + 1)
  const closePad = '  '.repeat(indent)

  if (propEntries.length === 0) {
    if (additional === false) return { ts: 'Record<string, never>', isUnion: false }
    if (additional === undefined || additional === true) return { ts: 'Record<string, unknown>', isUnion: false }
    const valType = convertNode(additional, depth + 1, indent, refDepth, state)
    return { ts: `Record<string, ${valType.ts}>`, isUnion: false }
  }

  const lines: string[] = []
  const seenKeys = new Set<string>()
  for (const [key, propSchema] of propEntries) {
    const keyTs = formatPropertyName(key)
    if (seenKeys.has(keyTs)) continue
    seenKeys.add(keyTs)
    const desc = descriptionOf(propSchema, state.opts.maxNestedDescriptionChars)
    if (desc !== null) lines.push(`${pad}/** ${desc} */`)
    const opt = required.has(key) ? '' : '?'
    const propType = convertNode(propSchema, depth + 1, indent + 1, refDepth, state)
    lines.push(`${pad}${keyTs}${opt}: ${propType.ts};`)
  }

  if (additional === true) {
    lines.push(`${pad}[key: string]: unknown;`)
  }

  const base: TypeExpr = { ts: `{\n${lines.join('\n')}\n${closePad}}`, isUnion: false }
  if (additional !== undefined && typeof additional !== 'boolean') {
    const valType = convertNode(additional, depth + 1, indent, refDepth, state)
    return joinIntersection([base, { ts: `Record<string, ${valType.ts}>`, isUnion: false }])
  }
  return base
}

function formatArrayType(obj: Record<string, unknown>, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  const prefixItems = safeGet(obj, 'prefixItems')
  const items = safeGet(obj, 'items')

  // JSON Schema 2020-12 tuple (`prefixItems`) or Draft-07 tuple (`items` array)
  const tupleSchemas = Array.isArray(prefixItems) ? prefixItems : Array.isArray(items) ? items : null
  if (tupleSchemas !== null) {
    if (tupleSchemas.length > state.opts.maxProperties) return { ts: 'unknown', isUnion: false }
    const parts = tupleSchemas.map(item => convertNode(item, depth + 1, indent, refDepth, state).ts)
    if (Array.isArray(prefixItems) && items !== undefined && typeof items !== 'boolean') {
      const rest = convertNode(items, depth + 1, indent, refDepth, state)
      parts.push(`...Array<${rest.ts}>`)
    }
    return { ts: `[${parts.join(', ')}]`, isUnion: false }
  }

  if (items === false) return { ts: '[]', isUnion: false }
  if (items === undefined || items === true) return { ts: 'Array<unknown>', isUnion: false }
  const elem = convertNode(items, depth + 1, indent, refDepth, state)
  return { ts: `Array<${elem.ts}>`, isUnion: false }
}

function convertByTypeName(typeName: string, obj: Record<string, unknown>, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  switch (typeName) {
    case 'string':
      return { ts: 'string', isUnion: false }
    case 'number':
    case 'integer':
      return { ts: 'number', isUnion: false }
    case 'boolean':
      return { ts: 'boolean', isUnion: false }
    case 'null':
      return { ts: 'null', isUnion: false }
    case 'array':
      return formatArrayType(obj, depth, indent, refDepth, state)
    case 'object':
      return formatObjectType(obj, depth, indent, refDepth, state)
    default:
      return { ts: 'unknown', isUnion: false }
  }
}

function convertNode(schema: unknown, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  if (depth > state.opts.maxDepth || ++state.nodes > MAX_NODE_VISITS) {
    return { ts: 'unknown', isUnion: false }
  }
  if (schema === true) return { ts: 'unknown', isUnion: false }
  if (schema === false) return { ts: 'never', isUnion: false }
  if (!isPlainRecord(schema)) return { ts: 'unknown', isUnion: false }

  const nullable = safeGet(schema, 'nullable')

  // Local $ref resolution
  const rawRef = safeGet(schema, '$ref')
  let refExpr: TypeExpr | null = null
  if (rawRef !== undefined) {
    if (typeof rawRef !== 'string' || state.activeRefs.has(rawRef) || refDepth >= state.opts.maxRefDepth || ++state.refExpansions > MAX_REF_EXPANSIONS) {
      return { ts: 'unknown', isUnion: false }
    }
    const target = resolveLocalRef(state.root, rawRef)
    if (!target.found) return { ts: 'unknown', isUnion: false }
    state.activeRefs.add(rawRef)
    try {
      refExpr = convertNode(target.value, depth, indent, refDepth + 1, state)
    } finally {
      state.activeRefs.delete(rawRef)
    }
  }

  // `const`
  if (Object.hasOwn(schema, 'const')) {
    const expr = literalToType(safeGet(schema, 'const'), depth, indent, state)
    return applyNullable(refExpr ? joinIntersection([refExpr, expr]) : expr, nullable)
  }

  // `enum`
  const rawEnum = safeGet(schema, 'enum')
  if (Array.isArray(rawEnum)) {
    if (rawEnum.length === 0) return { ts: 'never', isUnion: false }
    if (rawEnum.length <= MAX_ENUM_VALUES) {
      const expr = joinUnion(rawEnum.map(v => literalToType(v, depth, indent, state)))
      return applyNullable(refExpr ? joinIntersection([refExpr, expr]) : expr, nullable)
    }
    // Over enum cap: fall back to declared primitive type if safe, else `unknown`.
    const rawType = safeGet(schema, 'type')
    if (typeof rawType === 'string' && (rawType === 'string' || rawType === 'number' || rawType === 'integer' || rawType === 'boolean')) {
      return applyNullable(convertByTypeName(rawType, schema, depth, indent, refDepth, state), nullable)
    }
    return { ts: 'unknown', isUnion: false }
  }

  const parts: TypeExpr[] = []
  if (refExpr) parts.push(refExpr)

  // Combinators: allOf, oneOf, anyOf
  const rawAllOf = safeGet(schema, 'allOf')
  if (Array.isArray(rawAllOf) && rawAllOf.length > 0) {
    if (rawAllOf.length > state.opts.maxProperties) return { ts: 'unknown', isUnion: false }
    parts.push(joinIntersection(rawAllOf.map(sub => convertNode(sub, depth + 1, indent, refDepth, state))))
  }

  const rawOneOf = safeGet(schema, 'oneOf')
  if (Array.isArray(rawOneOf)) {
    if (rawOneOf.length === 0) return { ts: 'never', isUnion: false }
    if (rawOneOf.length > state.opts.maxProperties) return { ts: 'unknown', isUnion: false }
    parts.push(joinUnion(rawOneOf.map(sub => convertNode(sub, depth + 1, indent, refDepth, state))))
  }

  const rawAnyOf = safeGet(schema, 'anyOf')
  if (Array.isArray(rawAnyOf)) {
    if (rawAnyOf.length === 0) return { ts: 'never', isUnion: false }
    if (rawAnyOf.length > state.opts.maxProperties) return { ts: 'unknown', isUnion: false }
    parts.push(joinUnion(rawAnyOf.map(sub => convertNode(sub, depth + 1, indent, refDepth, state))))
  }

  // Explicit `type` or implicit object/array keywords
  const rawType = safeGet(schema, 'type')
  const hasObjectShape = Object.hasOwn(schema, 'properties') || Object.hasOwn(schema, 'additionalProperties')
  const hasArrayShape = Object.hasOwn(schema, 'items') || Object.hasOwn(schema, 'prefixItems')

  if (typeof rawType === 'string') {
    parts.push(convertByTypeName(rawType, schema, depth, indent, refDepth, state))
  } else if (Array.isArray(rawType)) {
    const typeBranches: TypeExpr[] = []
    for (const t of rawType) {
      if (typeof t === 'string') typeBranches.push(convertByTypeName(t, schema, depth, indent, refDepth, state))
    }
    parts.push(joinUnion(typeBranches))
  } else if (hasObjectShape) {
    parts.push(formatObjectType(schema, depth, indent, refDepth, state))
  } else if (hasArrayShape) {
    parts.push(formatArrayType(schema, depth, indent, refDepth, state))
  }

  if (parts.length === 0) return { ts: 'unknown', isUnion: false }
  return applyNullable(joinIntersection(parts), nullable)
}

function convertAtIndent(schema: unknown, indent: number, opts: ResolvedOptions): string {
  try {
    if (!fitsWithinByteBound(schema, opts.maxSchemaBytes)) return 'unknown'
    const state: GenState = {
      root: schema,
      opts,
      properties: 0,
      refExpansions: 0,
      nodes: 0,
      activeRefs: new Set(),
    }
    return convertNode(schema, 0, indent, 0, state).ts
  } catch {
    return 'unknown'
  }
}

/**
 * Converts a single JSON Schema to a TypeScript type string.
 * Enforces N43/N47 bounds (16 KiB size, depth 8, 200 properties, bounded local `$ref`s),
 * returning `'unknown'` for anything invalid or past bounds without throwing.
 */
export function jsonSchemaToType(schema: unknown, options?: TypesGenOptions): string {
  return convertAtIndent(schema, 0, resolveOptions(options))
}

function hasRequiredArgs(schema: unknown): boolean {
  try {
    if (!isPlainRecord(schema)) return true
    if (Object.hasOwn(schema, '$ref') || Object.hasOwn(schema, 'oneOf') || Object.hasOwn(schema, 'anyOf') || Object.hasOwn(schema, 'allOf')) {
      return true
    }
    const t = safeGet(schema, 'type')
    if (t !== undefined && t !== 'object') return true
    const req = safeGet(schema, 'required')
    if (!Array.isArray(req) || req.length === 0) return false
    return req.some(item => typeof item === 'string')
  } catch {
    return true
  }
}

/**
 * Generates `declare const tools: { ... };` TypeScript declarations for code-mode tools.
 * Never throws; escapes untrusted descriptions inside JSDoc and quotes unsafe identifiers.
 */
export function generateToolsDeclarations(tools: readonly ToolSchemaDescriptor[], options?: TypesGenOptions): string {
  const opts = resolveOptions(options)
  if (!Array.isArray(tools) || tools.length === 0 || opts.maxTools === 0) {
    return 'declare const tools: Record<string, never>;\n'
  }

  const servers = new Map<string, { serverKey: string; tools: ToolSchemaDescriptor[]; seenToolKeys: Set<string> }>()
  let count = 0
  for (const tool of tools) {
    if (count >= opts.maxTools) break
    if (!tool || typeof tool !== 'object') continue
    let server: unknown
    let name: unknown
    try {
      server = tool.server
      name = tool.name
    } catch {
      continue
    }
    if (typeof server !== 'string' || typeof name !== 'string') continue
    const serverKey = formatPropertyName(server)
    const toolKey = formatPropertyName(name)
    let entry = servers.get(serverKey)
    if (!entry) {
      entry = { serverKey, tools: [], seenToolKeys: new Set() }
      servers.set(serverKey, entry)
    }
    if (entry.seenToolKeys.has(toolKey)) continue
    entry.seenToolKeys.add(toolKey)
    entry.tools.push(tool)
    count++
  }

  if (servers.size === 0) {
    return 'declare const tools: Record<string, never>;\n'
  }

  const lines: string[] = ['declare const tools: {']
  for (const { serverKey, tools: serverTools } of servers.values()) {
    lines.push(`  readonly ${serverKey}: {`)
    for (const tool of serverTools) {
      let descRaw: unknown
      let mode: unknown
      let inputSchema: unknown
      let outputSchema: unknown
      try {
        descRaw = tool.description
        mode = tool.mode
        inputSchema = tool.inputSchema
        outputSchema = tool.outputSchema
      } catch {
        descRaw = undefined
        mode = undefined
        inputSchema = undefined
        outputSchema = undefined
      }

      const desc = typeof descRaw === 'string' ? escapeJsDoc(descRaw, opts.maxToolDescriptionChars) : ''
      const isWrite = mode === 'write'
      if (desc.length > 0 || isWrite) {
        lines.push('    /**')
        if (desc.length > 0) lines.push(`     * ${desc}`)
        if (isWrite) lines.push('     * Write tool: records a proposal and returns { proposed: true } without running.')
        lines.push('     */')
      }

      const inputTs = convertAtIndent(inputSchema, 2, opts)
      const opt = inputTs === 'unknown' ? true : !hasRequiredArgs(inputSchema)
      const outputTs = isWrite
        ? '{ proposed: true }'
        : outputSchema !== undefined
          ? convertAtIndent(outputSchema, 2, opts)
          : 'unknown'

      lines.push(`    readonly ${formatPropertyName(tool.name)}: (${opt ? 'args?' : 'args'}: ${inputTs}) => Promise<${outputTs}>;`)
    }
    lines.push('  };')
  }
  lines.push('};')
  return `${lines.join('\n')}\n`
}
