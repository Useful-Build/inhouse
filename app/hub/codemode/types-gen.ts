// Pure TypeScript declaration generator for code-mode tools (Stage 1 M4-K2, N43, N44, N47, N53).
// Zero runtime dependencies: turns MCP tool input/output JSON Schemas into `declare const tools` TypeScript
// declarations. All schema text (descriptions, property names, enum values, server/tool names) is untrusted:
// JSDoc comments cannot be closed early or inject TS directives, invisible characters are stripped or escaped,
// non-identifier property names are safely quoted, and anything malformed or past bounds degrades cleanly
// without throwing.

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
export const MAX_SCHEMA_OUTPUT_CHARS = 32 * 1024
export const MAX_TOTAL_OUTPUT_CHARS = 256 * 1024
export const MAX_NAME_CHARS = 128
export const MAX_LITERAL_STRING_CHARS = 512

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
  readonly maxSchemaOutputChars?: number
  readonly maxTotalOutputChars?: number
}

type ResolvedOptions = {
  maxTools: number
  maxSchemaBytes: number
  maxDepth: number
  maxProperties: number
  maxRefDepth: number
  maxToolDescriptionChars: number
  maxNestedDescriptionChars: number
  maxSchemaOutputChars: number
  maxTotalOutputChars: number
}

type TypeExpr = { ts: string; isUnion: boolean }

type GenState = {
  root: unknown
  opts: ResolvedOptions
  properties: number
  refExpansions: number
  nodes: number
  outputChars: number
  budgetExceeded: boolean
  activeRefs: Set<string>
}

const UNKNOWN: TypeExpr = { ts: 'unknown', isUnion: false }
const NEVER: TypeExpr = { ts: 'never', isUnion: false }

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

// C0/C1 controls (after line breaks/tabs are normalized to spaces), all Unicode Format chars (\p{Cf}: zero-width
// spaces/joiners, bidi marks/overrides/isolates, soft hyphen, Mongolian vowel separator, BOM, Arabic letter mark,
// invisible math operators, tag chars U+E0001..U+E007F), plus U+E0000, Hangul fillers, and variation selectors.
const INVISIBLE_OR_CONTROL_CHAR =
  /[\u0000-\u001F\u007F-\u009F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\p{Cf}]/gu

// Characters to \u-escape inside TS string literals: backticks, DEL/C1 controls, JS line/paragraph separators,
// Hangul fillers, variation selectors, Unicode tag block, and all \p{Cf} invisible/format/bidi characters.
const UNSAFE_STRING_LITERAL_CHAR =
  /[`\u007F-\u009F\u115F\u1160\u3164\uFFA0\u2028\u2029\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\p{Cf}]/gu

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
    maxSchemaOutputChars: clampLimit(options?.maxSchemaOutputChars, MAX_SCHEMA_OUTPUT_CHARS),
    maxTotalOutputChars: clampLimit(options?.maxTotalOutputChars, MAX_TOTAL_OUTPUT_CHARS),
  }
}

function wellFormed(text: string): string {
  const fn = (text as { toWellFormed?: () => string }).toWellFormed
  return typeof fn === 'function' ? fn.call(text) : text
}

function sliceUtf16Safe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let cut = maxChars
  if (cut > 0) {
    const lastCode = text.charCodeAt(cut - 1)
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut--
  }
  return text.slice(0, cut)
}

function chargeOutput(state: GenState, chars: number): boolean {
  state.outputChars += chars
  if (state.outputChars > state.opts.maxSchemaOutputChars) {
    state.budgetExceeded = true
    return false
  }
  return true
}

/**
 * Escapes untrusted text for placement inside a `/** ... * /` JSDoc comment.
 * Pre-caps oversized inputs before running regexes, normalizes line terminators, strips controls and invisible
 * Unicode characters, replaces backticks, breaks TS directives (`@ts-*`), neutralizes `/*` and `* /`, and caps
 * length without splitting surrogate pairs.
 */
export function escapeJsDoc(text: string, maxLength: number = MAX_TOOL_DESCRIPTION_CHARS): string {
  if (typeof text !== 'string') return ''
  const limit = clampLimit(maxLength, MAX_TOOL_DESCRIPTION_CHARS)
  if (limit === 0 || text.length === 0) return ''

  // Slice huge inputs (e.g. 50 MB) to a small multiple of `limit` before running regex passes.
  const preLimit = Math.max(limit * 8, 1024)
  const sliced = sliceUtf16Safe(text, preLimit)

  let out = wellFormed(sliced)
    // Normalize all line/paragraph breaks and tabs to spaces so JSDoc stays single-line and cannot forge tags.
    .replace(/[\r\n\t\u0085\u2028\u2029]+/g, ' ')
    // Strip remaining C0/C1 controls, \p{Cf} format/bidi/zero-width chars, variation selectors, Hangul fillers, tags.
    .replace(INVISIBLE_OR_CONTROL_CHAR, '')
    // Replace backticks so declarations embedded in template literals or markdown code fences cannot break out.
    .replace(/`/g, "'")
    // Neutralize comment openers and closers. Loop so neither `/*` nor `*/` can survive or appear via interaction.
    .replace(/\/\*/g, '/ *')
    .replace(/\*\//g, '* /')
    .trim()

  while (out.includes('*/') || out.includes('/*')) {
    out = out.replace(/\/\*/g, '/ *').replace(/\*\//g, '* /')
  }

  // Neutralize TypeScript directives (`@ts-expect-error`, `@ts-ignore`, `@ts-nocheck`, `@ts-check`) after
  // invisible chars and comment markers are cleaned so obfuscation like `@\u200Bts-ignore` cannot bypass it.
  out = out.replace(/@(?=ts-)/gi, '@ ')

  if (out.length > limit) {
    out = sliceUtf16Safe(out, limit).trimEnd()
  }
  return out
}

/** Quotes a string as a single-line, TypeScript-safe string literal with no raw backticks, separators or invisible chars. */
function safeStringLiteral(value: string): string {
  return JSON.stringify(wellFormed(value)).replace(UNSAFE_STRING_LITERAL_CHAR, ch => {
    const cp = ch.codePointAt(0)!
    return cp <= 0xffff ? `\\u${cp.toString(16).padStart(4, '0')}` : `\\u{${cp.toString(16)}}`
  })
}

export function isValidIdentifier(name: string): boolean {
  return typeof name === 'string' && VALID_ASCII_IDENT.test(name) && !RESERVED_IDENTIFIERS.has(name)
}

/** Formats a property, server, or tool name safely for TypeScript object type literals. */
export function formatPropertyName(name: string): string {
  if (typeof name !== 'string') return '""'
  return isValidIdentifier(name) ? name : safeStringLiteral(name)
}

/** Caps oversized server/tool names before formatting and shrinks cleanly if escapes inflate past limit. */
function formatBoundedName(raw: string, maxChars: number = MAX_NAME_CHARS): string {
  let bounded = sliceUtf16Safe(raw, maxChars)
  const maxFormatted = maxChars * 2
  let formatted = formatPropertyName(bounded)
  while (formatted.length > maxFormatted && bounded.length > 0) {
    const nextCut = Math.max(0, Math.floor((bounded.length * maxFormatted) / formatted.length) - 1)
    bounded = sliceUtf16Safe(bounded, nextCut)
    formatted = formatPropertyName(bounded)
  }
  return formatted
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
 * Returns `false` if cyclic, over `maxBytes`, over `Math.max(256, maxBytes)` nodes, or if any getter/Proxy throws.
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
  if (state.budgetExceeded || depth > state.opts.maxDepth || ++state.nodes > MAX_NODE_VISITS) {
    return UNKNOWN
  }
  if (value === null) {
    return chargeOutput(state, 4) ? { ts: 'null', isUnion: false } : UNKNOWN
  }
  switch (typeof value) {
    case 'string': {
      // Degrade long const/enum string literals to `string` to prevent output amplification.
      if (value.length > MAX_LITERAL_STRING_CHARS) {
        return chargeOutput(state, 6) ? { ts: 'string', isUnion: false } : UNKNOWN
      }
      const lit = safeStringLiteral(value)
      if (lit.length > MAX_LITERAL_STRING_CHARS * 2) {
        return chargeOutput(state, 6) ? { ts: 'string', isUnion: false } : UNKNOWN
      }
      return chargeOutput(state, lit.length) ? { ts: lit, isUnion: false } : UNKNOWN
    }
    case 'number': {
      const ts = !Number.isFinite(value) ? 'number' : Object.is(value, -0) ? '0' : String(value)
      return chargeOutput(state, ts.length) ? { ts: ts, isUnion: false } : UNKNOWN
    }
    case 'boolean': {
      const ts = value ? 'true' : 'false'
      return chargeOutput(state, ts.length) ? { ts: ts, isUnion: false } : UNKNOWN
    }
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length > state.opts.maxProperties) return UNKNOWN
        const sepCost = 2 + Math.max(0, value.length - 1) * 2
        if (!chargeOutput(state, sepCost)) return UNKNOWN
        const elems: string[] = []
        for (const item of value) {
          if (state.budgetExceeded) return UNKNOWN
          elems.push(literalToType(item, depth + 1, indent + 1, state).ts)
          if (state.budgetExceeded) return UNKNOWN
        }
        return { ts: `[${elems.join(', ')}]`, isUnion: false }
      }
      if (!isPlainRecord(value)) return UNKNOWN
      const entries = safeEntries(value)
      if (state.properties + entries.length > state.opts.maxProperties) return UNKNOWN
      state.properties += entries.length
      if (entries.length === 0) {
        return chargeOutput(state, 21) ? { ts: 'Record<string, never>', isUnion: false } : UNKNOWN
      }
      const pad = '  '.repeat(indent + 1)
      const closePad = '  '.repeat(indent)
      if (!chargeOutput(state, closePad.length + 4)) return UNKNOWN
      const lines: string[] = []
      const seenKeys = new Set<string>()
      for (const [k, v] of entries) {
        if (state.budgetExceeded || state.outputChars + k.length > state.opts.maxSchemaOutputChars) {
          state.budgetExceeded = true
          return UNKNOWN
        }
        const keyTs = formatPropertyName(k)
        if (seenKeys.has(keyTs)) continue
        seenKeys.add(keyTs)
        if (!chargeOutput(state, pad.length + keyTs.length + 4)) return UNKNOWN
        const valTs = literalToType(v, depth + 1, indent + 1, state).ts
        if (state.budgetExceeded) return UNKNOWN
        lines.push(`${pad}${keyTs}: ${valTs};`)
      }
      return { ts: `{\n${lines.join('\n')}\n${closePad}}`, isUnion: false }
    }
    default:
      return UNKNOWN
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
  if (unique.length === 0) return NEVER
  if (unique.length === 1) return unique[0]!
  return { ts: unique.map(e => e.ts).join(' | '), isUnion: true }
}

function joinIntersection(exprs: readonly TypeExpr[]): TypeExpr {
  const filtered = dedupeTypes(exprs)
  if (filtered.length === 0) return UNKNOWN
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

  const rawRequired = safeGet(obj, 'required')
  const required = new Set<string>()
  const missingRequired: string[] = []
  if (Array.isArray(rawRequired)) {
    for (const item of rawRequired) {
      if (typeof item === 'string') {
        if (!required.has(item)) {
          required.add(item)
          if (!hasPropsObj || !Object.hasOwn(rawProps, item)) {
            missingRequired.push(item)
          }
        }
      }
    }
  }

  const totalPropCount = propEntries.length + missingRequired.length
  if (state.properties + totalPropCount > state.opts.maxProperties) {
    return UNKNOWN
  }
  state.properties += totalPropCount

  const additional = safeGet(obj, 'additionalProperties')
  const pad = '  '.repeat(indent + 1)
  const closePad = '  '.repeat(indent)

  if (totalPropCount === 0) {
    if (additional === false) {
      return chargeOutput(state, 21) ? { ts: 'Record<string, never>', isUnion: false } : UNKNOWN
    }
    if (additional === undefined || additional === true) {
      return chargeOutput(state, 23) ? { ts: 'Record<string, unknown>', isUnion: false } : UNKNOWN
    }
    const valType = convertNode(additional, depth + 1, indent, refDepth, state)
    if (state.budgetExceeded || !chargeOutput(state, 16)) return UNKNOWN
    return { ts: `Record<string, ${valType.ts}>`, isUnion: false }
  }

  if (!chargeOutput(state, closePad.length + 4)) return UNKNOWN

  const hasSchemaAdditional = additional !== undefined && typeof additional !== 'boolean'
  let additionalType: TypeExpr | undefined
  if (hasSchemaAdditional) {
    additionalType = convertNode(additional, depth + 1, indent + 1, refDepth, state)
    if (state.budgetExceeded) return UNKNOWN
  }

  const lines: string[] = []
  const seenKeys = new Set<string>()
  const propTypes: TypeExpr[] = []
  let hasOptionalProp = false

  for (const [key, propSchema] of propEntries) {
    if (state.budgetExceeded || state.outputChars + key.length > state.opts.maxSchemaOutputChars) {
      state.budgetExceeded = true
      return UNKNOWN
    }
    const keyTs = formatPropertyName(key)
    if (seenKeys.has(keyTs)) continue
    seenKeys.add(keyTs)

    const desc = descriptionOf(propSchema, state.opts.maxNestedDescriptionChars)
    const isOptional = !required.has(key)
    if (isOptional) hasOptionalProp = true
    const opt = isOptional ? '?' : ''
    const overhead = (desc !== null ? pad.length + desc.length + 9 : 0) + pad.length + keyTs.length + opt.length + 4
    if (!chargeOutput(state, overhead)) return UNKNOWN

    if (desc !== null) lines.push(`${pad}/** ${desc} */`)
    const propType = convertNode(propSchema, depth + 1, indent + 1, refDepth, state)
    if (state.budgetExceeded) return UNKNOWN
    propTypes.push(propType)
    lines.push(`${pad}${keyTs}${opt}: ${propType.ts};`)
  }

  // Emit required keys absent from `properties` (typed via additionalProperties, `never` if forbidden, else `unknown`).
  for (const reqKey of missingRequired) {
    if (state.budgetExceeded || state.outputChars + reqKey.length > state.opts.maxSchemaOutputChars) {
      state.budgetExceeded = true
      return UNKNOWN
    }
    const keyTs = formatPropertyName(reqKey)
    if (seenKeys.has(keyTs)) continue
    seenKeys.add(keyTs)

    let reqType: TypeExpr
    if (additional === false) {
      reqType = NEVER
      if (!chargeOutput(state, reqType.ts.length)) return UNKNOWN
    } else if (additionalType !== undefined) {
      reqType = additionalType
      // Account for repeating additionalType for another property line.
      if (!chargeOutput(state, reqType.ts.length)) return UNKNOWN
    } else {
      reqType = UNKNOWN
      if (!chargeOutput(state, reqType.ts.length)) return UNKNOWN
    }
    if (!chargeOutput(state, pad.length + keyTs.length + 4)) return UNKNOWN
    propTypes.push(reqType)
    lines.push(`${pad}${keyTs}: ${reqType.ts};`)
  }

  if (additional === true) {
    if (!chargeOutput(state, pad.length + 25)) return UNKNOWN
    lines.push(`${pad}[key: string]: unknown;`)
  } else if (additionalType !== undefined) {
    // Emit a compatible index signature unifying additionalProperties with named properties (plus `undefined` if any
    // property is optional) instead of intersecting `Record<string, V>`, which narrows disjoint properties to `never`.
    let indexTs = 'unknown'
    if (additionalType.ts !== 'unknown' && propTypes.every(p => p.ts !== 'unknown')) {
      const candidates: TypeExpr[] = [additionalType, ...propTypes]
      if (hasOptionalProp) candidates.push({ ts: 'undefined', isUnion: false })
      const unified = joinUnion(candidates)
      // additionalType.ts was already charged above; charge the delta needed for the union index signature.
      const extraCost = Math.max(0, unified.ts.length - additionalType.ts.length)
      if (state.outputChars + pad.length + 20 + extraCost <= state.opts.maxSchemaOutputChars) {
        indexTs = unified.ts
      }
    }
    const lineCost = pad.length + 18 + Math.max(0, indexTs.length - additionalType.ts.length)
    if (!chargeOutput(state, lineCost)) return UNKNOWN
    lines.push(`${pad}[key: string]: ${indexTs};`)
  }

  return { ts: `{\n${lines.join('\n')}\n${closePad}}`, isUnion: false }
}

function formatArrayType(obj: Record<string, unknown>, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  const prefixItems = safeGet(obj, 'prefixItems')
  const items = safeGet(obj, 'items')
  const additionalItems = safeGet(obj, 'additionalItems')

  // JSON Schema 2020-12 tuple (`prefixItems` + `items`) or Draft-07 tuple (`items` array + `additionalItems`)
  const isPrefixTuple = Array.isArray(prefixItems)
  const isDraft07Tuple = !isPrefixTuple && Array.isArray(items)
  const tupleSchemas = isPrefixTuple ? prefixItems : isDraft07Tuple ? items : null

  if (tupleSchemas !== null) {
    if (tupleSchemas.length > state.opts.maxProperties) return UNKNOWN
    const parts: string[] = []
    for (const item of tupleSchemas) {
      if (state.budgetExceeded) return UNKNOWN
      parts.push(convertNode(item, depth + 1, indent, refDepth, state).ts)
      if (state.budgetExceeded) return UNKNOWN
    }
    const restSchema = isPrefixTuple ? items : additionalItems
    if (restSchema === true) {
      const restPart = '...Array<unknown>'
      if (!chargeOutput(state, restPart.length)) return UNKNOWN
      parts.push(restPart)
    } else if (restSchema !== undefined && restSchema !== false) {
      const rest = convertNode(restSchema, depth + 1, indent, refDepth, state)
      if (state.budgetExceeded || !chargeOutput(state, 10)) return UNKNOWN
      parts.push(`...Array<${rest.ts}>`)
    }
    const sepCost = 2 + Math.max(0, parts.length - 1) * 2
    if (!chargeOutput(state, sepCost)) return UNKNOWN
    return { ts: `[${parts.join(', ')}]`, isUnion: false }
  }

  if (items === false) {
    return chargeOutput(state, 2) ? { ts: '[]', isUnion: false } : UNKNOWN
  }
  if (items === undefined || items === true) {
    return chargeOutput(state, 14) ? { ts: 'Array<unknown>', isUnion: false } : UNKNOWN
  }
  const elem = convertNode(items, depth + 1, indent, refDepth, state)
  if (state.budgetExceeded || !chargeOutput(state, 7)) return UNKNOWN
  return { ts: `Array<${elem.ts}>`, isUnion: false }
}

function convertByTypeName(typeName: string, obj: Record<string, unknown>, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  switch (typeName) {
    case 'string':
      return chargeOutput(state, 6) ? { ts: 'string', isUnion: false } : UNKNOWN
    case 'number':
    case 'integer':
      return chargeOutput(state, 6) ? { ts: 'number', isUnion: false } : UNKNOWN
    case 'boolean':
      return chargeOutput(state, 7) ? { ts: 'boolean', isUnion: false } : UNKNOWN
    case 'null':
      return chargeOutput(state, 4) ? { ts: 'null', isUnion: false } : UNKNOWN
    case 'array':
      return formatArrayType(obj, depth, indent, refDepth, state)
    case 'object':
      return formatObjectType(obj, depth, indent, refDepth, state)
    default:
      return UNKNOWN
  }
}

function convertNode(schema: unknown, depth: number, indent: number, refDepth: number, state: GenState): TypeExpr {
  if (state.budgetExceeded || depth > state.opts.maxDepth || ++state.nodes > MAX_NODE_VISITS) {
    return UNKNOWN
  }
  if (schema === true) return chargeOutput(state, 7) ? UNKNOWN : UNKNOWN
  if (schema === false) return chargeOutput(state, 5) ? NEVER : UNKNOWN
  if (!isPlainRecord(schema)) return UNKNOWN

  const nullable = safeGet(schema, 'nullable')

  // Local $ref resolution
  const rawRef = safeGet(schema, '$ref')
  let refExpr: TypeExpr | null = null
  if (rawRef !== undefined) {
    if (typeof rawRef !== 'string' || state.activeRefs.has(rawRef) || refDepth >= state.opts.maxRefDepth || ++state.refExpansions > MAX_REF_EXPANSIONS) {
      return UNKNOWN
    }
    const target = resolveLocalRef(state.root, rawRef)
    if (!target.found) return UNKNOWN
    state.activeRefs.add(rawRef)
    try {
      refExpr = convertNode(target.value, depth, indent, refDepth + 1, state)
    } finally {
      state.activeRefs.delete(rawRef)
    }
    if (state.budgetExceeded) return UNKNOWN
  }

  // `const`
  if (Object.hasOwn(schema, 'const')) {
    const expr = literalToType(safeGet(schema, 'const'), depth, indent, state)
    if (state.budgetExceeded) return UNKNOWN
    return applyNullable(refExpr ? joinIntersection([refExpr, expr]) : expr, nullable)
  }

  // `enum`
  const rawEnum = safeGet(schema, 'enum')
  if (Array.isArray(rawEnum)) {
    if (rawEnum.length === 0) return chargeOutput(state, 5) ? NEVER : UNKNOWN
    if (rawEnum.length <= MAX_ENUM_VALUES) {
      const enumExprs: TypeExpr[] = []
      for (const v of rawEnum) {
        if (state.budgetExceeded) return UNKNOWN
        enumExprs.push(literalToType(v, depth, indent, state))
        if (state.budgetExceeded) return UNKNOWN
      }
      const expr = joinUnion(enumExprs)
      if (!chargeOutput(state, Math.max(0, expr.ts.length - enumExprs.reduce((acc, e) => acc + e.ts.length, 0)))) {
        return UNKNOWN
      }
      return applyNullable(refExpr ? joinIntersection([refExpr, expr]) : expr, nullable)
    }
    // Over enum cap: fall back to declared primitive type if safe, else `unknown`.
    const rawType = safeGet(schema, 'type')
    if (typeof rawType === 'string' && (rawType === 'string' || rawType === 'number' || rawType === 'integer' || rawType === 'boolean')) {
      return applyNullable(convertByTypeName(rawType, schema, depth, indent, refDepth, state), nullable)
    }
    return UNKNOWN
  }

  const parts: TypeExpr[] = []
  if (refExpr) parts.push(refExpr)

  // Combinators: allOf, oneOf, anyOf
  const rawAllOf = safeGet(schema, 'allOf')
  if (Array.isArray(rawAllOf) && rawAllOf.length > 0) {
    if (rawAllOf.length > state.opts.maxProperties) return UNKNOWN
    const subs: TypeExpr[] = []
    for (const sub of rawAllOf) {
      if (state.budgetExceeded) return UNKNOWN
      subs.push(convertNode(sub, depth + 1, indent, refDepth, state))
      if (state.budgetExceeded) return UNKNOWN
    }
    parts.push(joinIntersection(subs))
  }

  const rawOneOf = safeGet(schema, 'oneOf')
  if (Array.isArray(rawOneOf)) {
    if (rawOneOf.length === 0) return chargeOutput(state, 5) ? NEVER : UNKNOWN
    if (rawOneOf.length > state.opts.maxProperties) return UNKNOWN
    const subs: TypeExpr[] = []
    for (const sub of rawOneOf) {
      if (state.budgetExceeded) return UNKNOWN
      subs.push(convertNode(sub, depth + 1, indent, refDepth, state))
      if (state.budgetExceeded) return UNKNOWN
    }
    parts.push(joinUnion(subs))
  }

  const rawAnyOf = safeGet(schema, 'anyOf')
  if (Array.isArray(rawAnyOf)) {
    if (rawAnyOf.length === 0) return chargeOutput(state, 5) ? NEVER : UNKNOWN
    if (rawAnyOf.length > state.opts.maxProperties) return UNKNOWN
    const subs: TypeExpr[] = []
    for (const sub of rawAnyOf) {
      if (state.budgetExceeded) return UNKNOWN
      subs.push(convertNode(sub, depth + 1, indent, refDepth, state))
      if (state.budgetExceeded) return UNKNOWN
    }
    parts.push(joinUnion(subs))
  }

  // Explicit `type` or implicit object/array keywords
  const rawType = safeGet(schema, 'type')
  const hasObjectShape =
    Object.hasOwn(schema, 'properties') || Object.hasOwn(schema, 'additionalProperties') || Object.hasOwn(schema, 'required')
  const hasArrayShape = Object.hasOwn(schema, 'items') || Object.hasOwn(schema, 'prefixItems')

  if (typeof rawType === 'string') {
    parts.push(convertByTypeName(rawType, schema, depth, indent, refDepth, state))
  } else if (Array.isArray(rawType)) {
    const typeBranches: TypeExpr[] = []
    for (const t of rawType) {
      if (state.budgetExceeded) return UNKNOWN
      if (typeof t === 'string') {
        typeBranches.push(convertByTypeName(t, schema, depth, indent, refDepth, state))
        if (state.budgetExceeded) return UNKNOWN
      }
    }
    parts.push(joinUnion(typeBranches))
  } else if (hasObjectShape) {
    parts.push(formatObjectType(schema, depth, indent, refDepth, state))
  } else if (hasArrayShape) {
    parts.push(formatArrayType(schema, depth, indent, refDepth, state))
  }

  if (state.budgetExceeded) return UNKNOWN
  if (parts.length === 0) return UNKNOWN
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
      outputChars: 0,
      budgetExceeded: false,
      activeRefs: new Set(),
    }
    const result = convertNode(schema, 0, indent, 0, state)
    if (state.budgetExceeded || result.ts.length > opts.maxSchemaOutputChars) return 'unknown'
    return result.ts
  } catch {
    return 'unknown'
  }
}

/**
 * Converts a single JSON Schema to a TypeScript type string.
 * Enforces N43/N47 bounds (16 KiB input size, depth 8, 200 properties, bounded local `$ref`s, 32 KiB output budget),
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

const EMPTY_TOOLS_DECL = 'declare const tools: Record<string, never>;\n'

/**
 * Generates `declare const tools: { ... };` TypeScript declarations for code-mode tools.
 * Never throws; escapes untrusted descriptions inside JSDoc, quotes unsafe identifiers, and enforces per-schema
 * and total output character budgets.
 */
export function generateToolsDeclarations(tools: readonly ToolSchemaDescriptor[], options?: TypesGenOptions): string {
  const opts = resolveOptions(options)
  if (opts.maxTools === 0 || opts.maxTotalOutputChars < EMPTY_TOOLS_DECL.length) {
    return EMPTY_TOOLS_DECL
  }

  type ToolEntry = { toolKey: string; tool: ToolSchemaDescriptor }
  const servers = new Map<string, { serverKey: string; tools: ToolEntry[]; seenToolKeys: Set<string> }>()
  let count = 0

  try {
    if (!Array.isArray(tools) || tools.length === 0) {
      return EMPTY_TOOLS_DECL
    }
    for (let i = 0; i < tools.length; i++) {
      if (count >= opts.maxTools) break
      const tool = tools[i]
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
      const serverKey = formatBoundedName(server, MAX_NAME_CHARS)
      const toolKey = formatBoundedName(name, MAX_NAME_CHARS)
      let entry = servers.get(serverKey)
      if (!entry) {
        entry = { serverKey, tools: [], seenToolKeys: new Set() }
        servers.set(serverKey, entry)
      }
      if (entry.seenToolKeys.has(toolKey)) continue
      entry.seenToolKeys.add(toolKey)
      entry.tools.push({ toolKey, tool })
      count++
    }
  } catch {
    // Hostile Proxy/array getter during iteration: keep any valid tools gathered before the throw, or fall back cleanly.
  }

  if (servers.size === 0) {
    return EMPTY_TOOLS_DECL
  }

  const lines: string[] = ['declare const tools: {']
  let totalChars = 'declare const tools: {\n};\n'.length
  let totalBudgetFull = false

  for (const { serverKey, tools: serverTools } of servers.values()) {
    if (totalBudgetFull) break
    const serverOpen = `  readonly ${serverKey}: {`
    const serverClose = '  };'
    const serverFrameChars = serverOpen.length + 1 + serverClose.length + 1
    if (totalChars + serverFrameChars > opts.maxTotalOutputChars) break

    const serverLines: string[] = []
    let serverChars = serverFrameChars

    for (const { toolKey, tool } of serverTools) {
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
      const commentLines: string[] = []
      if (desc.length > 0 || isWrite) {
        commentLines.push('    /**')
        if (desc.length > 0) commentLines.push(`     * ${desc}`)
        if (isWrite) commentLines.push('     * Write tool: records a proposal and returns { proposed: true } without running.')
        commentLines.push('     */')
      }

      const remaining = opts.maxTotalOutputChars - (totalChars + serverChars)
      const perSchemaOpts =
        remaining < opts.maxSchemaOutputChars ? { ...opts, maxSchemaOutputChars: Math.max(0, remaining) } : opts

      const inputTs = convertAtIndent(inputSchema, 2, perSchemaOpts)
      const opt = inputTs === 'unknown' ? true : !hasRequiredArgs(inputSchema)
      const outputTs = isWrite
        ? '{ proposed: true }'
        : outputSchema !== undefined
          ? convertAtIndent(outputSchema, 2, perSchemaOpts)
          : 'unknown'

      const sigLine = `    readonly ${toolKey}: (${opt ? 'args?' : 'args'}: ${inputTs}) => Promise<${outputTs}>;`
      const toolLines = [...commentLines, sigLine]
      const toolBlockChars = toolLines.reduce((sum, l) => sum + l.length + 1, 0)

      if (totalChars + serverChars + toolBlockChars <= opts.maxTotalOutputChars) {
        serverLines.push(...toolLines)
        serverChars += toolBlockChars
        continue
      }

      // Over total output budget: degrade this tool's schemas to `unknown` if the minimal signature still fits, then stop.
      const fallbackOutput = isWrite ? '{ proposed: true }' : 'unknown'
      const fallbackSig = `    readonly ${toolKey}: (args?: unknown) => Promise<${fallbackOutput}>;`
      if (totalChars + serverChars + fallbackSig.length + 1 <= opts.maxTotalOutputChars) {
        serverLines.push(fallbackSig)
        serverChars += fallbackSig.length + 1
      }
      totalBudgetFull = true
      break
    }

    if (serverLines.length > 0) {
      lines.push(serverOpen, ...serverLines, serverClose)
      totalChars += serverChars
    }
  }

  if (lines.length === 1) {
    return EMPTY_TOOLS_DECL
  }

  lines.push('};')
  return `${lines.join('\n')}\n`
}
