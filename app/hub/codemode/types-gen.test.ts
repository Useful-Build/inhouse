// M4-K2 type generator tests (N43, N44, N47, N53).
// Failure modes:
// - a tool or property description closes its JSDoc comment (`*/`), injects TS directives (`@ts-*`), leaves invisible
//   control/format/tag characters raw, or stalls regexes on multi-megabyte inputs;
// - a hostile property, server or tool name isn't quoted and injects TypeScript code or blows output size;
// - a schema past bounds (16 KiB input, 32 KiB output, depth 8, 200 properties, cyclic/external $ref, $ref amplification,
//   billion-laughs DAG) throws, hangs, or blows up output size;
// - generated declarations fail `tsc --strict` or mishandle additionalProperties, required keys, tuples, enums, or $refs.
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
  MAX_ENUM_VALUES,
  MAX_LITERAL_STRING_CHARS,
  MAX_NAME_CHARS,
  MAX_NESTED_DESCRIPTION_CHARS,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_OUTPUT_CHARS,
  MAX_SCHEMA_PROPERTIES,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOLS_COUNT,
  MAX_TOTAL_OUTPUT_CHARS,
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

  it('handles JSON Schema edge cases (#620 & #621): additionalProperties, required-only keys, tuples, enum caps and format', () => {
    const edgeTools: ToolSchemaDescriptor[] = [
      {
        server: 'edge',
        name: 'schema_additional',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            optionalFlag: { type: 'boolean' },
          },
          required: ['id'],
          additionalProperties: { type: 'string' },
        },
      },
      {
        server: 'edge',
        name: 'open_additional',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'string' } },
          additionalProperties: true,
        },
      },
      {
        server: 'edge',
        name: 'req_only',
        inputSchema: {
          type: 'object',
          required: ['id', 'email'],
        },
      },
      {
        server: 'edge',
        name: 'req_allof',
        inputSchema: {
          allOf: [
            { $ref: '#/$defs/Base' },
            { required: ['email'] },
          ],
          $defs: {
            Base: {
              type: 'object',
              properties: { id: { type: 'string' }, email: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      },
      {
        server: 'edge',
        name: 'tuple_rest_open',
        inputSchema: {
          type: 'array',
          prefixItems: [{ type: 'number' }, { type: 'number' }],
          items: true,
        },
      },
      {
        server: 'edge',
        name: 'tuple_rest_typed',
        inputSchema: {
          type: 'array',
          prefixItems: [{ type: 'number' }],
          items: { type: 'string' },
        },
      },
      {
        server: 'edge',
        name: 'tuple_draft07_rest',
        inputSchema: {
          type: 'array',
          items: [{ type: 'number' }],
          additionalItems: { type: 'string' },
        },
      },
      {
        server: 'edge',
        name: 'with_format',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            hostile: { type: 'string', format: '*/; eval(1); /*' },
          },
          required: ['email', 'hostile'],
        },
      },
    ]

    const decls = generateToolsDeclarations(edgeTools)
    expect(decls).toContain('[key: string]: string | number | boolean | undefined;')
    expect(decls).toContain('email: unknown;')
    expect(decls).toContain('[number, number, ...Array<unknown>]')
    expect(decls).toContain('[number, ...Array<string>]')
    expect(decls).not.toContain('eval(1)')

    const usage = `
async function checkEdge(): Promise<void> {
  await tools.edge.schema_additional({ id: 1, tag: 'vip' });
  await tools.edge.schema_additional({ id: 1, optionalFlag: true, tag: 'vip' });
  // @ts-expect-error extra object property fails string | number | boolean index signature
  await tools.edge.schema_additional({ id: 1, bad: { nested: 1 } });

  await tools.edge.open_additional({ a: 'ok', extra: { any: 1 } });
  await tools.edge.req_only({ id: '1', email: 'a@b.c' });
  // @ts-expect-error missing required email
  await tools.edge.req_only({ id: '1' });

  await tools.edge.req_allof({ id: '1', email: 'a@b.c' });
  // @ts-expect-error allOf required email missing
  await tools.edge.req_allof({ id: '1' });

  await tools.edge.tuple_rest_open([1, 2]);
  await tools.edge.tuple_rest_open([1, 2, 'extra', true]);
  // @ts-expect-error first element must be number
  await tools.edge.tuple_rest_open(['bad', 2]);

  await tools.edge.tuple_rest_typed([1, 'a', 'b']);
  await tools.edge.tuple_draft07_rest([1, 'a', 'b']);
  // @ts-expect-error rest must be string
  await tools.edge.tuple_rest_typed([1, 2]);

  await tools.edge.with_format({ email: 'a@b.c', hostile: 'ok' });
}
void checkEdge;
`
    typecheckFiles({ 'tools.d.ts': decls, 'usage.ts': usage })

    // Draft-07 additionalItems: true & additionalProperties: false missing-required & MAX_ENUM_VALUES
    expect(
      jsonSchemaToType({
        type: 'array',
        items: [{ type: 'boolean' }],
        additionalItems: true,
      }),
    ).toBe('[boolean, ...Array<unknown>]')
    expect(
      jsonSchemaToType({
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id', 'missing'],
        additionalProperties: false,
      }),
    ).toContain('missing: never;')

    const bigEnum = Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => `v${i}`)
    expect(jsonSchemaToType({ type: 'string', enum: bigEnum })).toBe('string')
    expect(jsonSchemaToType({ type: 'integer', enum: Array.from({ length: MAX_ENUM_VALUES + 1 }, (_, i) => i) })).toBe('number')
    expect(jsonSchemaToType({ enum: bigEnum })).toBe('unknown')

    const tooManyRequired = Array.from({ length: MAX_SCHEMA_PROPERTIES + 1 }, (_, i) => `r${i}`)
    expect(jsonSchemaToType({ type: 'object', required: tooManyRequired })).toBe('unknown')
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

describe('types-gen: JSDoc escaping, invisible chars (#616), directives and N53 planted attacks (#617)', () => {
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

    // Computed ['__proto__'] creates an own property without altering Object.getPrototypeOf(properties).
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
            ['__proto__']: { type: 'number' },
          },
          required: ['foo: string; } eval(1); const z = { a'],
        },
      },
    ])

    // Controls: hostile names and escaped nested description were actually emitted (not dropped to `unknown`).
    expect(decls).toContain('"tool: string; } console.log(1); const y = { a"')
    expect(decls).toContain('"foo: string; } eval(1); const z = { a": string;')
    expect(decls).toContain('"__proto__"?: number;')
    expect(decls).toContain('/** Nested * / ; throw new Error("pwned"); / * */')
    // Security: no raw comment breakouts survived.
    expect(decls).not.toContain('*/ ; eval')
    expect(decls).not.toContain('*/ ; throw')
    typecheckFiles({ 'tools.d.ts': decls })
  })

  it('strips invisible/format/tag characters in comments and \\u-escapes them in string literals (#616)', () => {
    const invisibles = [
      '\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u2060', '\uFEFF', '\u061C', '\u00AD', '\u180E',
      '\u2061', '\u2062', '\u2063', '\u2064', '\uFE00', '\uFE0F', '\u115F', '\u1160', '\u3164', '\uFFA0',
      '\u{E0000}', '\u{E0001}', '\u{E0041}', '\u{E007F}', '\u{E0100}', '\u{E01EF}',
    ]
    const joined = invisibles.map((ch, idx) => `p${idx}${ch}`).join('_')
    expect(escapeJsDoc(`clean_${joined}_text`)).toMatch(/^clean_(?:p\d+_)*p\d+_text$/)

    const decls = generateToolsDeclarations([
      {
        server: `srv${invisibles[0]}x`,
        name: `tl${invisibles[22]}y`,
        description: `tool_${joined}`,
        inputSchema: {
          type: 'object',
          properties: {
            [`k\u200B\u061C\u00AD\u180E\u200E\u{E0041}\u{E0100}`]: {
              type: 'string',
              description: `prop_${joined}`,
              enum: ['a\u200Bb\u{E0001}c\u2061d\uFE00e\u3164f'],
            },
          },
          required: [`k\u200B\u061C\u00AD\u180E\u200E\u{E0041}\u{E0100}`],
        },
      },
    ])

    // None of the invisible characters may appear raw anywhere in the emitted declarations.
    expect(decls).not.toMatch(
      /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u115F\u1160\u3164\uFFA0\u2028\u2029\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\p{Cf}]/u,
    )
    expect(decls).toContain('\\u200b')
    expect(decls).toContain('\\u200e')
    expect(decls).toContain('\\u{e0041}')
    typecheckFiles({ 'tools.d.ts': decls })
  })

  it('neutralizes TS comment directives (@ts-expect-error, @ts-ignore, @ts-nocheck) in descriptions (#616)', () => {
    const decls = generateToolsDeclarations([
      {
        server: 'dirsrv',
        name: 'dirtool',
        description: '@ts-nocheck',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'string', description: '@ts-expect-error' },
            b: { type: 'string', description: '@ts-ignore' },
            c: { type: 'string', description: '@\u200Bts-expect-error' },
            d: { type: 'string', description: '@TS-ignore' },
          },
          required: ['a', 'b', 'c', 'd'],
        },
      },
    ])

    expect(decls).not.toMatch(/@ts-(?:expect-error|ignore|nocheck|check)/i)
    // Must compile cleanly without TS2578 unused directive error.
    typecheckFiles({ 'tools.d.ts': decls })

    // Verify a subsequent error is NOT muted by the neutralized @ts-ignore inside property comments:
    expect(() =>
      typecheckFiles({
        'tools.d.ts': `${decls}\ndeclare const check: number = "not a number";\n`,
      }),
    ).toThrow(/TS2322/)
  })

  it('truncates tool descriptions to 1024 chars and nested descriptions to 200 chars, even on 50 MB strings', () => {
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

    // 50 MB description pre-slicing check (Fable H1)
    const start = performance.now()
    const escaped50Mb = escapeJsDoc('a'.repeat(50_000_000))
    const escapedClosers = escapeJsDoc('\r\n*/'.repeat(12_500_000))
    const elapsedMs = performance.now() - start
    expect(escaped50Mb.length).toBe(MAX_TOOL_DESCRIPTION_CHARS)
    expect(escapedClosers.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_CHARS)
    expect(escapedClosers).not.toContain('*/')
    expect(elapsedMs).toBeLessThan(200)
  })
})

describe('types-gen: bounds, amplification caps and never-throw guarantees', () => {
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

  it('caps const/enum string literals, $ref amplification (Fable & Neon repros), names, and total output (H1)', () => {
    // Long const / enum literals degrade to `string`
    expect(jsonSchemaToType({ const: 'a'.repeat(MAX_LITERAL_STRING_CHARS + 1) })).toBe('string')
    expect(jsonSchemaToType({ enum: ['a'.repeat(10_000), 'ok'] })).toBe('string | "ok"')

    // Fable H1 repro: 199 $refs to 11,000-char \u007F enum (<16 KiB JSON -> previously 525 MB across 20 tools)
    const fableRepro = {
      type: 'array',
      prefixItems: Array.from({ length: 199 }, () => ({ $ref: '#/$defs/a' })),
      $defs: { a: { enum: ['\u007F'.repeat(11_000)] } },
    }
    const fableSingle = jsonSchemaToType(fableRepro)
    expect(fableSingle.length).toBeLessThanOrEqual(MAX_SCHEMA_OUTPUT_CHARS)
    const fable20 = generateToolsDeclarations(
      Array.from({ length: 20 }, (_, i) => ({
        server: 'srv',
        name: `t_${i}`,
        inputSchema: fableRepro,
        outputSchema: fableRepro,
      })),
    )
    expect(fable20.length).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_CHARS)
    typecheckFiles({ 'tools.d.ts': fable20 })

    // Neon repro: 200 $refs to 10,000-char const (<16 KiB JSON -> bounded output)
    const neonRepro = {
      type: 'array',
      prefixItems: Array.from({ length: 199 }, () => ({ $ref: '#/$defs/big' })),
      $defs: { big: { const: 'x'.repeat(10_000) } },
    }
    const neonOut = jsonSchemaToType(neonRepro)
    expect(neonOut.length).toBeLessThanOrEqual(MAX_SCHEMA_OUTPUT_CHARS)

    // Multi-property $ref amplification under MAX_SCHEMA_PROPERTIES (16 * 10 = 160 <= 200) that exceeds 32 KiB
    // output budget -> GenState aborts and degrades to `unknown`.
    const mediumProps: Record<string, unknown> = {}
    for (let i = 0; i < 10; i++) mediumProps[`field_${i}`] = { type: 'string', description: 'd'.repeat(200) }
    const ampSchema = {
      type: 'array',
      prefixItems: Array.from({ length: 16 }, () => ({ $ref: '#/$defs/Row' })),
      $defs: { Row: { type: 'object', properties: mediumProps } },
    }
    const ampOut = jsonSchemaToType(ampSchema)
    expect(ampOut).toBe('unknown')
    expect(ampOut.length).toBeLessThanOrEqual(MAX_SCHEMA_OUTPUT_CHARS)

    // Total output cap across 20 large schemas that individually fit under 32 KiB
    const perToolProps: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) perToolProps[`prop_${i}`] = { type: 'string', description: 'y'.repeat(150) }
    const largeToolSchema = {
      type: 'array',
      prefixItems: Array.from({ length: 3 }, () => ({ $ref: '#/$defs/Obj' })),
      $defs: { Obj: { type: 'object', properties: perToolProps } },
    }
    const totalCapped = generateToolsDeclarations(
      Array.from({ length: 20 }, (_, i) => ({
        server: 'bigsrv',
        name: `tool_${i}`,
        inputSchema: largeToolSchema,
        outputSchema: largeToolSchema,
      })),
    )
    expect(totalCapped.length).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_CHARS)
    typecheckFiles({ 'tools.d.ts': totalCapped })

    // Over-long server and tool names (10 MB) are bounded and compile cleanly
    const hugeNames = generateToolsDeclarations([
      {
        server: 's'.repeat(10_000_000),
        name: '\u007F'.repeat(10_000_000),
        inputSchema: { type: 'object', properties: {} },
      },
    ])
    expect(hugeNames.length).toBeLessThan(MAX_NAME_CHARS * 6)
    typecheckFiles({ 'tools.d.ts': hugeNames })
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
    const start = performance.now()
    const dag = jsonSchemaToType({ $ref: '#/$defs/L0', $defs: defs })
    const elapsedMs = performance.now() - start
    expect(dag).toContain('unknown')
    expect(dag.length).toBeLessThanOrEqual(MAX_SCHEMA_OUTPUT_CHARS)
    expect(elapsedMs).toBeLessThan(200)
  })

  it('never throws on hostile JS values (cycles, throwing Proxies/arrays/getters, NaN/Infinity, caps)', () => {
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

    // Hostile getter that changes or throws on second read of tool.name (#621)
    let nameReads = 0
    const mutatingNameTool = {
      server: 'srv',
      get name(): string {
        nameReads++
        if (nameReads > 1) throw new Error('second read throws')
        return 'stable_name'
      },
      inputSchema: { type: 'object', properties: {} },
    } as unknown as ToolSchemaDescriptor
    const fromMutating = generateToolsDeclarations([mutatingNameTool])
    expect(fromMutating).toContain('readonly stable_name:')
    typecheckFiles({ 'tools.d.ts': fromMutating })

    // Hostile Proxy array (#615 Low)
    const throwingArray = new Proxy([] as ToolSchemaDescriptor[], {
      get(_target, prop) {
        if (prop === 'length' || prop === Symbol.iterator) throw new Error('proxy array throw')
        return undefined
      },
    })
    expect(generateToolsDeclarations(throwingArray)).toBe('declare const tools: Record<string, never>;\n')

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
  fc.string({ unit: 'binary', minLength: 0, maxLength: 120 }),
  fc.constantFrom(
    '*/',
    '**/',
    '/*/',
    '*/; process.exit(1); /*',
    '*/ } console.log("pwned"); const x = {',
    '```\nconst pwned = 1;\n```',
    '`${process.exit(1)}`',
    '~~~js\nboom\n~~~',
    'line1\u2028line2\u2029line3\u0085\r\n\0',
    'foo: string; } eval(1); const y = { a',
    '__proto__',
    'constructor',
    'delete',
    'a\uD800b\uDFFFc',
    'bid\u202Eoverride',
    '@ts-expect-error',
    '@ts-ignore',
    '@ts-nocheck',
    '@\u200Bts-expect-error',
    'zw\u200B\u200D\u2060\uFEFF\u061C\u00AD\u180E',
    'tag\u{E0001}\u{E0041}end',
    'x'.repeat(25_000),
  ),
  fc
    .array(
      fc.oneof(
        fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }),
        fc.constantFrom(
          '*/', '/*', '`', '```', '~~~', '\n', '\r', '\u2028', '\u2029', '\u0085', '\0', '"; ', '}: ', '${x}',
          '\uD800', '\u202E', '\u200B', '\u{E0041}', '@ts-expect-error', '@ts-ignore', '@ts-nocheck',
        ),
      ),
      { minLength: 1, maxLength: 8 },
    )
    .map(parts => parts.join('')),
)

/** Creates a plain object without `__proto__` mutating the object's prototype. */
function safeObj(entries: readonly [string, unknown][]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of entries) {
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true })
  }
  return out
}

const primitiveLiteralArb: fc.Arbitrary<unknown> = fc.oneof(
  hostileStringArb,
  fc.double({ noNaN: false, noDefaultInfinity: false }),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
)

const randomSchemaArb: fc.Arbitrary<unknown> = fc.letrec(tie => {
  const leaf = fc.oneof(
    fc.record({
      type: fc.constantFrom('string', 'number', 'integer', 'boolean', 'null'),
      nullable: fc.boolean(),
      description: hostileStringArb,
      format: hostileStringArb,
    }),
    fc.record({ const: primitiveLiteralArb }),
    fc.record({
      const: fc.array(fc.tuple(hostileStringArb, primitiveLiteralArb), { maxLength: 3 }).map(safeObj),
    }),
    fc.record({ enum: fc.array(primitiveLiteralArb, { minLength: 1, maxLength: 4 }) }),
    fc.record({ type: fc.subarray(['string', 'number', 'boolean', 'null'], { minLength: 1, maxLength: 3 }) }),
    fc.constantFrom(true, false, null, 'bad-schema', { $ref: '#/$defs/A' }, { $ref: 'https://evil.example/x' }, { $ref: '#/__proto__/x' }),
  )

  return {
    node: fc.oneof(
      { depthSize: 'small', maxDepth: 2 },
      leaf,
      fc.record({
        type: fc.constant('array'),
        items: tie('node'),
      }),
      fc.record({
        type: fc.constant('array'),
        prefixItems: fc.array(tie('node'), { minLength: 1, maxLength: 3 }),
        items: fc.oneof(fc.boolean(), tie('node')),
      }),
      fc.record({
        type: fc.constant('object'),
        properties: fc.array(fc.tuple(hostileStringArb, tie('node')), { minLength: 0, maxLength: 3 }).map(safeObj),
        required: fc.array(hostileStringArb, { maxLength: 2 }),
        additionalProperties: fc.oneof(fc.boolean(), tie('node')),
        description: hostileStringArb,
      }),
      fc.record({ oneOf: fc.array(tie('node'), { minLength: 1, maxLength: 2 }) }),
      fc.record({ anyOf: fc.array(tie('node'), { minLength: 1, maxLength: 2 }) }),
      fc.record({ allOf: fc.array(tie('node'), { minLength: 1, maxLength: 2 }) }),
      fc.record({
        $ref: fc.constantFrom('#/$defs/A', '#/definitions/B', '#/$defs/Missing'),
      }),
    ),
  }
}).node

const rootSchemaWithDefsArb: fc.Arbitrary<unknown> = fc
  .tuple(randomSchemaArb, randomSchemaArb, randomSchemaArb)
  .map(([schema, defA, defB]) => {
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      return { ...(schema as Record<string, unknown>), $defs: { A: defA }, definitions: { B: defB } }
    }
    return schema
  })

const FIXED_DECL_KEYWORDS = new Set([
  'declare', 'const', 'tools', 'readonly', 'args', 'Promise', 'Record', 'Array', 'string', 'number',
  'boolean', 'null', 'undefined', 'unknown', 'never', 'true', 'false', 'key', 'proposed',
])

const ALLOWED_SCANNER_PUNCT = new Set(['{', '}', '(', ')', '[', ']', '<', '>', ':', ';', ',', '.', '?', '&', '|', '=', '-', '+', ' ', '\n'])

function collectInputIdentifiers(value: unknown, out: Set<string>, seen: Set<object>): void {
  if (typeof value === 'string') {
    if (isValidIdentifier(value)) out.add(value)
    const clipped = value.slice(0, MAX_NAME_CHARS)
    if (isValidIdentifier(clipped)) out.add(clipped)
    return
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectInputIdentifiers(item, out, seen)
    return
  }
  for (const key of Object.keys(value)) {
    if (isValidIdentifier(key)) out.add(key)
    collectInputIdentifiers((value as Record<string, unknown>)[key], out, seen)
  }
}

/**
 * Independent lexical scanner oracle: strips `/* ... * /` comments (first closer wins) and `"..."` string
 * literals, then verifies the remaining code contains only punctuation, fixed TS declaration keywords, numbers,
 * and identifiers originating directly from valid-identifier inputs.
 */
function assertDeclarationLexicallySafe(decls: string, inputDescriptors: readonly ToolSchemaDescriptor[]): void {
  expect(decls.length).toBeLessThanOrEqual(MAX_TOTAL_OUTPUT_CHARS)
  expect(decls).not.toContain('`')
  expect(decls).not.toMatch(
    /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u115F\u1160\u3164\uFFA0\u2028\u2029\uFE00-\uFE0F\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}\p{Cf}]/u,
  )

  const inputIdents = new Set<string>()
  const seen = new Set<object>()
  for (const d of inputDescriptors) {
    collectInputIdentifiers(d.server, inputIdents, seen)
    collectInputIdentifiers(d.name, inputIdents, seen)
    collectInputIdentifiers(d.inputSchema, inputIdents, seen)
    collectInputIdentifiers(d.outputSchema, inputIdents, seen)
  }

  let i = 0
  while (i < decls.length) {
    if (decls.startsWith('/*', i)) {
      const end = decls.indexOf('*/', i + 2)
      if (end === -1) throw new Error(`Unterminated comment at offset ${i}`)
      const body = decls.slice(i + 2, end)
      if (body.includes('/*')) throw new Error(`Unescaped comment opener inside comment: ${body}`)
      if (/@ts-(?:expect-error|ignore|nocheck|check)/i.test(body)) {
        throw new Error(`Live TS directive inside comment: ${body}`)
      }
      i = end + 2
      continue
    }
    const ch = decls[i]!
    if (ch === '"') {
      let j = i + 1
      let closed = false
      while (j < decls.length) {
        const c = decls[j]!
        if (c === '\n' || c === '\r') throw new Error(`Newline inside string literal at ${j}`)
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '"') {
          closed = true
          j++
          break
        }
        j++
      }
      if (!closed) throw new Error(`Unterminated string literal at offset ${i}`)
      i = j
      continue
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$') {
      let j = i + 1
      while (j < decls.length && /[A-Za-z0-9_$]/.test(decls[j]!)) j++
      const ident = decls.slice(i, j)
      if (!FIXED_DECL_KEYWORDS.has(ident) && !inputIdents.has(ident)) {
        throw new Error(`Unexpected unquoted identifier outside comment/literal: ${ident}`)
      }
      i = j
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i + 1
      while (j < decls.length && /[0-9.eE+-]/.test(decls[j]!)) j++
      i = j
      continue
    }
    if (!ALLOWED_SCANNER_PUNCT.has(ch)) {
      throw new Error(`Unexpected punctuation outside comment/literal: ${JSON.stringify(ch)}`)
    }
    i++
  }
}

describe('types-gen: fast-check property over hostile strings and random schemas', () => {
  it(
    'never throws, passes independent scanner & JSDoc invariants, and always passes tsc across 1,000 random schemas',
    { timeout: 30_000 },
    () => {
      const generatedModules: Record<string, string> = {}
      const caseRecords: { file: string; input: ToolSchemaDescriptor[]; decls: string }[] = []
      let idx = 0

      fc.assert(
        fc.property(
          hostileStringArb,
          hostileStringArb,
          hostileStringArb,
          fc.constantFrom<'read' | 'write' | undefined>('read', 'write', undefined),
          rootSchemaWithDefsArb,
          rootSchemaWithDefsArb,
          (server, name, toolDesc, mode, inputSchema, outputSchema) => {
            const input: ToolSchemaDescriptor[] = [
              { server, name, description: toolDesc, mode, inputSchema, outputSchema },
            ]
            const decls = generateToolsDeclarations(input)

            assertDeclarationLexicallySafe(decls, input)

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

            const file = `case_${idx++}.d.ts`
            generatedModules[file] = `export {};\n${decls}`
            caseRecords.push({ file, input, decls })
          },
        ),
        { numRuns: 1_000 },
      )

      try {
        typecheckFiles(generatedModules)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const match = /case_(\d+)\.d\.ts/.exec(message)
        if (match) {
          const bad = caseRecords[Number(match[1])]
          if (bad) {
            throw new Error(
              `${message}\n\nFailing file: ${bad.file}\nInput: ${JSON.stringify(bad.input)}\nDecls:\n${bad.decls}`,
            )
          }
        }
        throw err
      }
    },
  )
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
