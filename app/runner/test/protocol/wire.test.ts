// The Worker <-> runner schemas. Ways they could fail, written first:
// - a valid message doesn't survive encode then parse unchanged (round trip);
// - an unknown field slips through (every object is strict) or a known one is dropped;
// - a version outside ACCEPTED_VERSIONS is accepted, or a non-canonical spelling (`01`) of one is;
// - an empty prompt passes without resume; the body cap can't hold a RunStart at its field caps;
// - a deferred input or a usage over its cap passes;
// - negotiation picks a version one side doesn't speak.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import {
  ACCEPTED_VERSIONS,
  DEFERRED_INPUT_MAX_BYTES,
  PROMPT_MAX_CHARS,
  PROTOCOL_VERSION,
  RUN_START_MAX_BYTES,
  RunEventBody,
  USAGE_MAX_BYTES,
  RunStart,
  acceptsVersion,
  encodeRunEvent,
  negotiateVersion,
  parseRunEventLine,
  type RunEvent,
} from '../../../shared/protocol/index.ts'

const id = fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/)
const runStartFields = fc.record({
  runId: id,
  chatId: id,
  sessionId: fc.uuid({ version: 4 }),
  resume: fc.constant(true),
  prompt: fc.string({ maxLength: 200 }),
  model: fc.constantFrom('claude-sonnet-5-5', 'claude-opus-5-5'),
  effort: fc.constantFrom('low', 'medium', 'high', 'xhigh', 'max'),
  maxTurns: fc.integer({ min: 1, max: 500 }),
  maxBudgetUsd: fc.double({ min: 0.01, max: 1000, noNaN: true }),
  runToken: fc.stringMatching(/^[\x21-\x7e]{16,64}$/),
  webFetchDomains: fc.array(fc.domain().map((d) => d.toLowerCase()), { maxLength: 4 }),
  fileCaps: fc.record({
    maxFileBytes: fc.integer({ min: 1, max: 1e9 }),
    maxFilesPerTurn: fc.integer({ min: 1, max: 100 }),
    maxRestoreBytes: fc.integer({ min: 0, max: 1e9 }),
    allowedTypes: fc.array(fc.constantFrom('application/pdf', 'image/png', 'text/csv'), { maxLength: 3 }),
  }),
})
// `resume` is free except that an empty prompt needs it.
const runStartArb: fc.Arbitrary<RunStart> = fc
  .tuple(runStartFields, fc.boolean())
  .map(([s, resume]) => ({ ...s, resume: s.prompt === '' ? true : resume }))

const reason = fc.constantFrom('session_crashed', 'protocol', 'store', 'files', 'interrupted', 'stopped', 'timeout', 'sdk_error' as const)
const bodyArb: fc.Arbitrary<RunEventBody> = fc.oneof(
  fc.record({ type: fc.constant('started' as const), sessionId: fc.uuid({ version: 4 }), resume: fc.boolean() }),
  fc.record({ type: fc.constant('sdk' as const), message: fc.dictionary(fc.string(), fc.jsonValue()), truncated: fc.boolean() }),
  fc.record({ type: fc.constant('file_saved' as const), path: fc.string({ maxLength: 50 }), bytes: fc.nat(), contentType: fc.constant('application/pdf') }),
  fc.record({ type: fc.constant('file_refused' as const), path: fc.string({ maxLength: 50 }), reason: fc.constantFrom('too_large', 'too_many', 'type_not_allowed', 'save_failed', 'bad_name' as const) }),
  fc.record({ type: fc.constant('files_restored' as const), restored: fc.nat(), bytes: fc.nat(), leftOut: fc.array(fc.string({ maxLength: 50 }), { maxLength: 5 }) }),
  fc.record({
    type: fc.constant('audit' as const),
    entry: fc.record({ hook: fc.constantFrom('PreToolUse', 'PostToolUse'), toolName: fc.string({ maxLength: 40 }), toolUseId: fc.string({ maxLength: 40 }), decision: fc.constantFrom('allow', 'deny', 'defer'), input: fc.jsonValue({ maxDepth: 3 }) }, { requiredKeys: ['hook', 'toolName', 'decision', 'input'] }),
  }),
  fc.record({ type: fc.constant('mirror_error' as const), message: fc.string({ maxLength: 100 }) }),
  fc.record({ type: fc.constant('deferred' as const), toolUseId: fc.string({ maxLength: 40 }), toolName: fc.string({ maxLength: 40 }), input: fc.jsonValue() }),
  fc.record({ type: fc.constant('checkpoint' as const), entries: fc.nat() }),
  fc.record({
    type: fc.constant('finished' as const),
    subtype: fc.constantFrom('success', 'error_max_turns'),
    isError: fc.boolean(),
    numTurns: fc.nat(),
    costUsd: fc.double({ min: 0, max: 100, noNaN: true }),
    usage: fc.dictionary(fc.string(), fc.nat()),
  }),
  fc.record({ type: fc.constant('failed' as const), reason, message: fc.string({ maxLength: 100 }) }),
)

describe('RunStart', () => {
  it.prop([runStartArb])('round trips through JSON', (start) => {
    expect(RunStart.parse(JSON.parse(JSON.stringify(start)))).toEqual(start)
  })

  it.prop([runStartArb, fc.string({ minLength: 1, maxLength: 20 }).filter((k) => !(k in RunStart.shape) && k !== '__proto__')])(
    'refuses an unknown field',
    (start, key) => {
      expect(RunStart.safeParse({ ...start, [key]: 1 }).success).toBe(false)
    },
  )

  it.prop([runStartArb, fc.constantFrom(...Object.keys(RunStart.shape))])('refuses a missing field', (start, key) => {
    const copy: Record<string, unknown> = { ...start }
    delete copy[key]
    expect(RunStart.safeParse(copy).success).toBe(false)
  })

  it('takes "" as the deferred-answer resume prompt, and only with resume: true', () => {
    expect(RunStart.shape.prompt.parse('')).toBe('')
    const start = fc.sample(runStartArb, 1)[0]!
    expect(RunStart.safeParse({ ...start, prompt: '', resume: true }).success).toBe(true)
    const refused = RunStart.safeParse({ ...start, prompt: '', resume: false })
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.path).toEqual(['prompt'])
  })

  it('a RunStart at every field cap, its prompt written in the longest escapes, fits the body cap', () => {
    const start: RunStart = {
      runId: 'r'.repeat(64),
      chatId: 'c'.repeat(64),
      sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11',
      resume: true,
      // A control character is the longest a character gets in JSON: six bytes (\u0001).
      prompt: '\u0001'.repeat(PROMPT_MAX_CHARS),
      model: 'm'.repeat(128),
      effort: 'medium',
      maxTurns: 500,
      maxBudgetUsd: 1000,
      runToken: '!'.repeat(512),
      webFetchDomains: Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'a'.repeat(57)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`),
      fileCaps: { maxFileBytes: 1e15, maxFilesPerTurn: 1e15, maxRestoreBytes: 1e15, allowedTypes: Array.from({ length: 64 }, () => `application/${'x'.repeat(100)}`) },
    }
    expect(RunStart.safeParse(start).success).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(start)).length).toBeLessThanOrEqual(RUN_START_MAX_BYTES)
  })
})

describe('run events', () => {
  it.prop([bodyArb, id, fc.nat()])('round trip through an NDJSON line', (body, runId, seq) => {
    const event = { runId, seq, ...body } as RunEvent
    const line = encodeRunEvent(event)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(parseRunEventLine(line)).toEqual(JSON.parse(line))
  })

  it.prop([bodyArb, fc.string({ minLength: 1, maxLength: 12 }).filter((k) => !['type', 'runId', 'seq', '__proto__'].includes(k))])(
    'refuse an unknown field (the sdk message itself is open)',
    (body, key) => {
      if (key in body) return
      expect(() => parseRunEventLine(JSON.stringify({ runId: 'r', seq: 0, ...body, [key]: 1 }))).toThrow()
    },
  )

  it('refuse a negative or fractional seq, and an unknown type', () => {
    const ok = { runId: 'r', type: 'checkpoint', entries: 1 }
    expect(() => parseRunEventLine(JSON.stringify({ ...ok, seq: -1 }))).toThrow()
    expect(() => parseRunEventLine(JSON.stringify({ ...ok, seq: 1.5 }))).toThrow()
    expect(() => parseRunEventLine(JSON.stringify({ ...ok, seq: 0, type: 'mystery' }))).toThrow()
  })
})

describe('versions', () => {
  it('v1 accepts only itself (no phantom v0); the rule is current and previous once v2 exists', () => {
    expect(PROTOCOL_VERSION).toBe(1)
    expect(ACCEPTED_VERSIONS).toEqual([1])
    expect(acceptsVersion('1')).toBe(true)
    expect(acceptsVersion('0')).toBe(false)
  })

  it.prop([fc.oneof(fc.integer({ min: -100, max: 1000 }).map(String), fc.string(), fc.nat(1000).map((n) => `0${n}`))])(
    'accepts exactly the canonical decimal of an accepted version',
    (header) => {
      expect(acceptsVersion(header)).toBe(ACCEPTED_VERSIONS.some((v) => String(v) === header))
    },
  )

  it('refuses a missing header', () => {
    expect(acceptsVersion(undefined)).toBe(false)
    expect(acceptsVersion(null)).toBe(false)
  })

  it('a Worker one version ahead negotiates down to the runner', () => {
    const runner = { version: PROTOCOL_VERSION, accepted: [...ACCEPTED_VERSIONS] }
    const workerAhead = [PROTOCOL_VERSION + 1, PROTOCOL_VERSION]
    expect(negotiateVersion(runner, workerAhead)).toBe(PROTOCOL_VERSION)
    expect(negotiateVersion({ version: PROTOCOL_VERSION + 2, accepted: [PROTOCOL_VERSION + 2, PROTOCOL_VERSION + 1] })).toBeNull()
  })

  it.prop([fc.uniqueArray(fc.nat(10), { minLength: 1 }), fc.uniqueArray(fc.nat(10), { minLength: 1 })])(
    'negotiation picks a version both sides accept, the highest such',
    (peer, ours) => {
      const v = negotiateVersion({ version: Math.max(...peer), accepted: peer }, ours)
      const shared = peer.filter((x) => ours.includes(x))
      expect(v).toBe(shared.length ? Math.max(...shared) : null)
    },
  )
})

describe('caps on the open shapes', () => {
  it('a deferred input or a usage over its cap fails the parse; at the cap it passes', () => {
    // {"a":"..."} is 8 bytes of framing around the string.
    const sized = (bytes: number) => ({ a: 'x'.repeat(bytes - 8) })
    const deferred = (input: unknown) => RunEventBody.safeParse({ type: 'deferred', toolUseId: 't', toolName: 'n', input }).success
    const finished = (usage: Record<string, unknown>) =>
      RunEventBody.safeParse({ type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage }).success
    expect(deferred(sized(DEFERRED_INPUT_MAX_BYTES))).toBe(true)
    expect(deferred(sized(DEFERRED_INPUT_MAX_BYTES + 1))).toBe(false)
    expect(finished(sized(USAGE_MAX_BYTES))).toBe(true)
    expect(finished(sized(USAGE_MAX_BYTES + 1))).toBe(false)
  })
})
