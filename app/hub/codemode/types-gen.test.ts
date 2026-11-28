// M4-K2 type generator tests (N43, N44, N47, N53).
// Failure modes:
// - a tool or property description closes its JSDoc comment (`*/`) or injects code/markdown fences;
// - a hostile property, server or tool name isn't quoted and injects TypeScript code;
// - a schema past bounds (16 KiB, depth 8, 200 properties, cyclic/external $ref, billion-laughs DAG) throws or blows up;
// - generated declarations fail `tsc --strict` or lose nesting, enums, local `$ref`, `oneOf` or `anyOf`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HELPDESK_FIXTURE_TOOLS } from './__fixtures__/helpdesk-tools'
import {
  escapeJsDoc,
  formatPropertyName,
  generateToolsDeclarations,
  isValidIdentifier,
  jsonSchemaToType,
  MAX_NESTED_DESCRIPTION_CHARS,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PROPERTIES,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOLS_COUNT,
  type ToolSchemaDescriptor,
} from './types-gen'

const HERE = dirname(fileURLToPath(import.meta.url))
const TSC_BIN = resolve(HERE, '../node_modules/.bin/tsc')
const HELPDESK_SNAPSHOT = resolve(HERE, '__snapshots__/helpdesk-tools.d.ts.snap')

function typecheckFiles(files: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), 'types-gen-tsc-'))
  try {
    const paths: string[] = []
    for (const [name, content] of Object.entries(files)) {
      const p = join(dir, name)
      writeFileSync(p, content, 'utf8')
      paths.push(p)
    }
    execFileSync(TSC_BIN, ['--ignoreConfig', '--noEmit', '--strict', '--target', 'es2024', '--module', 'esnext', ...paths], {
      stdio: 'pipe',
    })
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
    const detail = [e.stdout?.toString('utf8'), e.stderr?.toString('utf8'), e.message].filter(Boolean).join('\n')
    throw new Error(`tsc failed:\n${detail}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Checked-in schemas covering nesting, enums, const, local $ref, oneOf, anyOf, allOf, tuples, odd names & Zod 4. */
const CHECKED_IN_TOOLS: readonly ToolSchemaDescriptor[] = [
  {
    server: 'orders-api',
    name: 'search',
    mode: 'read',
    description: 'Search orders with nested filters, enums, unions, and local $ref definitions.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'Filter criteria.',
          properties: {
            status: { type: 'string', enum: ['paid', 'pending', 'refunded'] },
            priority: { enum: [1, 2, 3, null] },
            range: { $ref: '#/$defs/DateRange' },
            matcher: {
              oneOf: [
                {
                  type: 'object',
                  properties: { kind: { const: 'sku' }, sku: { type: 'string' } },
                  required: ['kind', 'sku'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: { kind: { const: 'tag' }, tags: { type: 'array', items: { type: 'string' } } },
                  required: ['kind', 'tags'],
                  additionalProperties: false,
                },
              ],
            },
            note: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
          },
          required: ['status'],
          additionalProperties: false,
        },
        coords: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'number' }] },
        'x-request-id': { type: 'string', description: 'Header style kebab-case property.' },
        '123numeric': { type: 'boolean' },
        delete: { type: 'string' },
        'a~b/c': { $ref: '#/definitions/Escaped~0Key~1Name' },
      },
      required: ['filter'],
      additionalProperties: false,
      $defs: {
        DateRange: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string', nullable: true },
          },
          required: ['from'],
          additionalProperties: false,
        },
      },
      definitions: {
        'Escaped~Key/Name': {
          allOf: [
            { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            { type: 'object', properties: { active: { type: 'boolean' } }, required: ['active'] },
          ],
        },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { $ref: '#/$defs/OrderItem' },
        },
        cursor: { type: ['string', 'null'] },
      },
      required: ['items', 'cursor'],
      additionalProperties: false,
      $defs: {
        OrderItem: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            totalCents: { type: 'integer' },
          },
          required: ['id', 'totalCents'],
          additionalProperties: false,
        },
      },
    },
  },
  {
    server: 'shopify',
    name: 'shop_info',
    mode: 'read',
    description: 'Zero-arg tool generated from Zod 4 toJSONSchema.',
    inputSchema: z.toJSONSchema(z.strictObject({})),
    outputSchema: z.toJSONSchema(z.strictObject({ currencyCode: z.string(), name: z.string() })),
  },
  {
    server: 'shopify',
    name: 'order_tag_add',
    mode: 'write',
    description: 'Add a tag to an order.',
    inputSchema: z.toJSONSchema(z.strictObject({ orderId: z.string(), tag: z.string() })),
  },
]

describe('types-gen: checked-in schemas and tsc verification', () => {
  it('generates declarations for checked-in schemas that typecheck with tsc (positive and negative usage)', () => {
    const decls = generateToolsDeclarations(CHECKED_IN_TOOLS)

    const usage = `
async function verify(): Promise<void> {
  const res = await tools['orders-api'].search({
    filter: {
      status: 'paid',
      priority: null,
      range: { from: '2026-11-01', to: null },
      matcher: { kind: 'sku', sku: 'MUG-01' },
      note: 42,
    },
    coords: [52.5, 13.4],
    'x-request-id': 'req-1',
    '123numeric': true,
    delete: 'ok',
    'a~b/c': { id: '1', active: true },
  });
  const _firstId: string = res.items[0]!.id;
  const _cursor: string | null = res.cursor;

  const shop = await tools.shopify.shop_info();
  const shop2 = await tools.shopify.shop_info({});
  const _currency: string = shop.currencyCode;
  void shop2;

  const proposal = await tools.shopify.order_tag_add({ orderId: 'gid://1', tag: 'vip' });
  const _proposed: true = proposal.proposed;
  void _firstId; void _cursor; void _currency; void _proposed;

  // @ts-expect-error invalid enum value
  await tools['orders-api'].search({ filter: { status: 'invalid' } });
  // @ts-expect-error missing required property
  await tools['orders-api'].search({});
  // @ts-expect-error wrong tuple type
  await tools['orders-api'].search({ filter: { status: 'paid' }, coords: ['bad', 1] });
  // @ts-expect-error unknown property on zero-arg tool
  await tools.shopify.shop_info({ extra: 1 });
}
void verify;
`
    typecheckFiles({
      'tools.d.ts': decls,
      'usage.ts': usage,
    })
  })

  it('quotes non-identifiers, keywords and special Object.prototype property names', () => {
    expect(isValidIdentifier('valid_Name$1')).toBe(true)
    expect(isValidIdentifier('delete')).toBe(false)
    expect(isValidIdentifier('__proto__')).toBe(false)
    expect(isValidIdentifier('constructor')).toBe(false)
    expect(isValidIdentifier('123bad')).toBe(false)
    expect(isValidIdentifier('kebab-case')).toBe(false)
    expect(isValidIdentifier('')).toBe(false)

    expect(formatPropertyName('valid_name')).toBe('valid_name')
    expect(formatPropertyName('kebab-case')).toBe('"kebab-case"')
    expect(formatPropertyName('delete')).toBe('"delete"')
    expect(formatPropertyName('__proto__')).toBe('"__proto__"')
    expect(formatPropertyName('a\u2028b')).toBe('"a\\u2028b"')
  })
})

describe('types-gen: JSDoc escaping and N53 planted attacks', () => {
  it('blocks comment-closing sequences, openers, backticks and line separators in descriptions', () => {
    const attacks = [
      'hello */ process.exit(1); /* world',
      '**/',
      '/*/',
      '*\u0000/',
      '*/ /*',
      'line1\n * @evil\n */\nconsole.log(1)\r\n\u2028\u2029\u0085',
      '```ts\nconst pwned = 1;\n```',
      'a\uD800b\u202Ec',
    ]
    for (const raw of attacks) {
      const escaped = escapeJsDoc(raw)
      expect(escaped).not.toContain('*/')
      expect(escaped).not.toContain('/*')
      expect(escaped).not.toContain('`')
      expect(escaped).not.toMatch(/[\r\n\u0085\u2028\u2029\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/)
    }

    const decls = generateToolsDeclarations([
      {
        server: 'evil*/;const x=1;/*',
        name: 'tool: string; } console.log(1); const y = { a',
        description: 'Innocent */ ; eval("pwned"); /* ```ts\nboom\u2028',
        inputSchema: {
          type: 'object',
          properties: {
            'foo: string; } eval(1); const z = { a': {
              type: 'string',
              description: 'Nested */ ; throw new Error("pwned"); /*',
            },
            __proto__: { type: 'number' },
          },
          required: ['foo: string; } eval(1); const z = { a'],
        },
      },
    ])

    expect(decls).not.toContain('*/ ; eval')
    expect(decls).not.toContain('throw new Error')
    typecheckFiles({ 'tools.d.ts': decls })
  })

  it('truncates tool descriptions to 1024 chars and nested descriptions to 200 chars', () => {
    const longToolDesc = 'a'.repeat(2_000)
    const longPropDesc = 'b'.repeat(500)
    const decls = generateToolsDeclarations([
      {
        server: 's',
        name: 't',
        description: longToolDesc,
        inputSchema: {
          type: 'object',
          properties: {
            p: { type: 'string', description: longPropDesc },
          },
        },
      },
    ])
    expect(decls).toContain(`* ${'a'.repeat(MAX_TOOL_DESCRIPTION_CHARS)}`)
    expect(decls).not.toContain('a'.repeat(MAX_TOOL_DESCRIPTION_CHARS + 1))
    expect(decls).toContain(`/** ${'b'.repeat(MAX_NESTED_DESCRIPTION_CHARS)} */`)
    expect(decls).not.toContain('b'.repeat(MAX_NESTED_DESCRIPTION_CHARS + 1))
  })
})

describe('types-gen: bounds and never-throw guarantees', () => {
  it('enforces MAX_SCHEMA_DEPTH (depth 8 allowed, depth 9 becomes unknown)', () => {
    const makeNested = (levels: number): Record<string, unknown> => {
      let cur: Record<string, unknown> = { type: 'string' }
      for (let i = levels; i >= 1; i--) {
        cur = { type: 'object', properties: { [`l${i}`]: cur }, required: [`l${i}`], additionalProperties: false }
      }
      return cur
    }

    const atLimit = jsonSchemaToType(makeNested(MAX_SCHEMA_DEPTH))
    expect(atLimit).toContain('l8: string;')
    expect(atLimit).not.toContain('unknown')

    const pastLimit = jsonSchemaToType(makeNested(MAX_SCHEMA_DEPTH + 1))
    expect(pastLimit).toContain('l8: {\n')
    expect(pastLimit).toContain('l9: unknown;')
  })

  it('returns unknown when schema exceeds MAX_SCHEMA_BYTES (16 KiB) or MAX_SCHEMA_PROPERTIES (200)', () => {
    const hugeSchema = {
      type: 'object',
      properties: {
        big: { type: 'string', description: 'x'.repeat(MAX_SCHEMA_BYTES + 100) },
      },
    }
    expect(jsonSchemaToType(hugeSchema)).toBe('unknown')

    const tooManyProps: Record<string, unknown> = {}
    for (let i = 0; i <= MAX_SCHEMA_PROPERTIES; i++) tooManyProps[`p${i}`] = { type: 'string' }
    expect(jsonSchemaToType({ type: 'object', properties: tooManyProps })).toBe('unknown')
  })

  it('handles $ref cycles, mutual cycles, external $refs, prototype pointers and billion-laughs DAGs safely', () => {
    // Direct cycle
    expect(
      jsonSchemaToType({
        $ref: '#/$defs/Node',
        $defs: {
          Node: {
            type: 'object',
            properties: { next: { $ref: '#/$defs/Node' } },
          },
        },
      }),
    ).toContain('next?: unknown;')

    // Mutual cycle A -> B -> A
    const mutual = jsonSchemaToType({
      $ref: '#/$defs/A',
      $defs: {
        A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
      },
    })
    expect(mutual).toContain('a?: unknown;')

    // Self root ref
    expect(jsonSchemaToType({ $ref: '#' })).toBe('unknown')

    // External $ref never fetched or trusted
    expect(jsonSchemaToType({ $ref: 'https://evil.example.com/schema.json' })).toBe('unknown')
    expect(jsonSchemaToType({ $ref: './other.json#/$defs/Secret' })).toBe('unknown')

    // Prototype pollution pointers
    expect(jsonSchemaToType({ $ref: '#/__proto__/toString' })).toBe('unknown')
    expect(jsonSchemaToType({ $ref: '#/constructor/prototype' })).toBe('unknown')

    // Billion-laughs exponential DAG (10 branches per level, 8 levels -> 10^8 without caps)
    const defs: Record<string, unknown> = {}
    for (let lvl = 0; lvl < 8; lvl++) {
      const props: Record<string, unknown> = {}
      for (let k = 0; k < 10; k++) {
        props[`k${k}`] = lvl === 7 ? { type: 'string' } : { $ref: `#/$defs/L${lvl + 1}` }
      }
      defs[`L${lvl}`] = { type: 'object', properties: props }
    }
    const dag = jsonSchemaToType({ $ref: '#/$defs/L0', $defs: defs })
    expect(dag).toContain('unknown')
  })

  it('never throws on hostile JS values (cycles, throwing Proxies/getters, NaN/Infinity, caps)', () => {
    const cyclic: Record<string, unknown> = { type: 'object' }
    cyclic.properties = { self: cyclic }
    expect(jsonSchemaToType(cyclic)).toBe('unknown')

    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('boom')
        },
        ownKeys() {
          throw new Error('boom')
        },
        getOwnPropertyDescriptor() {
          throw new Error('boom')
        },
      },
    )
    expect(jsonSchemaToType(throwingProxy)).toBe('unknown')
    expect(jsonSchemaToType(null)).toBe('unknown')
    expect(jsonSchemaToType(undefined)).toBe('unknown')
    expect(jsonSchemaToType(42)).toBe('unknown')
    expect(jsonSchemaToType(true)).toBe('unknown')
    expect(jsonSchemaToType(false)).toBe('never')
    expect(jsonSchemaToType([])).toBe('unknown')
    expect(jsonSchemaToType({ enum: [Number.NaN, Number.POSITIVE_INFINITY, -0, 'ok'] })).toBe('number | 0 | "ok"')

    const throwingTool = {
      get server(): string {
        throw new Error('hostile getter')
      },
      name: 'x',
      inputSchema: {},
    } as unknown as ToolSchemaDescriptor
    expect(generateToolsDeclarations([throwingTool])).toBe('declare const tools: Record<string, never>;\n')

    // Tool count cap (MAX_TOOLS_COUNT = 20)
    const manyTools: ToolSchemaDescriptor[] = Array.from({ length: MAX_TOOLS_COUNT + 5 }, (_, i) => ({
      server: 'srv',
      name: `tool_${i}`,
      inputSchema: { type: 'object', properties: {} },
    }))
    const capped = generateToolsDeclarations(manyTools)
    expect(capped).toContain(`tool_${MAX_TOOLS_COUNT - 1}`)
    expect(capped).not.toContain(`tool_${MAX_TOOLS_COUNT}`)
  })
})

const hostileStringArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 120 }),
  fc.constantFrom(
    '*/',
    '**/',
    '/*/',
    '*/; process.exit(1); /*',
    '*/ } console.log("pwned"); const x = {',
    '```\nconst pwned = 1;\n```',
    '`${process.exit(1)}`',
    'line1\u2028line2\u2029line3\u0085\r\n\0',
    'foo: string; } eval(1); const y = { a',
    '__proto__',
    'constructor',
    'delete',
    'a\uD800b\uDFFFc',
    'bid\u202Eoverride',
    'x'.repeat(25_000),
  ),
  fc
    .array(
      fc.oneof(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.constantFrom('*/', '/*', '`', '```', '\n', '\r', '\u2028', '\u2029', '\u0085', '\0', '"; ', '}: ', '${x}', '\uD800', '\u202E'),
      ),
      { minLength: 1, maxLength: 8 },
    )
    .map(parts => parts.join('')),
)

describe('types-gen: fast-check property over hostile strings', () => {
  it('never throws, escapes JSDoc/separators/backticks, and always parses & typechecks with tsc', () => {
    const generatedModules: Record<string, string> = {}
    let idx = 0

    fc.assert(
      fc.property(
        hostileStringArb,
        hostileStringArb,
        hostileStringArb,
        hostileStringArb,
        hostileStringArb,
        hostileStringArb,
        (server, name, toolDesc, propName, propDesc, enumVal) => {
          const decls = generateToolsDeclarations([
            {
              server,
              name,
              description: toolDesc,
              inputSchema: {
                type: 'object',
                properties: {
                  [propName]: {
                    type: 'string',
                    description: propDesc,
                    enum: [enumVal, 'safe'],
                  },
                },
                required: [propName],
                additionalProperties: false,
              },
              outputSchema: {
                oneOf: [{ type: 'string' }, { const: enumVal }],
              },
            },
          ])

          // No unescaped backticks or raw Unicode/control line separators anywhere in generated declarations.
          expect(decls).not.toContain('`')
          expect(decls).not.toMatch(/[\u2028\u2029\u0085\u0000-\u0009\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/)

          // Every `/**` comment closes on its own block without an early `*/` inside the comment text.
          const commentLines = decls.split('\n').filter(l => l.trimStart().startsWith('/*') || l.trimStart().startsWith('*'))
          for (const line of commentLines) {
            const trimmed = line.trim()
            if (trimmed === '/**' || trimmed === '*/') continue
            if (trimmed.startsWith('/** ') && trimmed.endsWith(' */')) {
              const inner = trimmed.slice(4, -3)
              expect(inner).not.toContain('*/')
              expect(inner).not.toContain('/*')
            } else if (trimmed.startsWith('* ')) {
              const inner = trimmed.slice(2)
              expect(inner).not.toContain('*/')
              expect(inner).not.toContain('/*')
            } else {
              throw new Error(`Unexpected comment line format: ${trimmed}`)
            }
          }

          // Module-scoped `.d.ts` so all 50 generated cases typecheck together in one fast `tsc` run.
          generatedModules[`case_${idx++}.d.ts`] = `export {};\n${decls}`
        },
      ),
      { numRuns: 50 },
    )

    typecheckFiles(generatedModules)
  })
})

describe('types-gen: helpdesk fixture snapshot', () => {
  it('matches the checked-in snapshot and typechecks with tsc', async () => {
    const decls = generateToolsDeclarations(HELPDESK_FIXTURE_TOOLS)
    await expect(decls).toMatchFileSnapshot(HELPDESK_SNAPSHOT)

    const usage = `
async function checkHelpdesk(): Promise<void> {
  const found = await tools.helpdesk.tickets_search({ status: 'open', tags: ['refund'] });
  const _subj: string = found.tickets[0]!.subject;
  const ticket = await tools.helpdesk.ticket_get({ ticketId: 101 });
  const _email: string = ticket.customer.email;
  const _reply = await tools.helpdesk.ticket_reply({ ticketId: 101, bodyText: 'On it.' });
  const _macro = await tools.helpdesk.ticket_macro_apply({ ticketId: 101, macroId: 'm_refund' });
  const _p1: true = _reply.proposed;
  const _p2: true = _macro.proposed;
  void _subj; void _email; void _p1; void _p2;
}
void checkHelpdesk;
`
    typecheckFiles({
      'helpdesk.d.ts': decls,
      'usage.ts': usage,
    })
  })
})
