// The Worker <-> runner schemas. Ways they could fail, written first:
// - a valid message doesn't survive encode then parse unchanged (round trip);
// - an unknown field slips through (every object is strict) or a known one is dropped;
// - a version outside ACCEPTED_VERSIONS is accepted, or a non-canonical spelling (`01`) of one is;
// - an empty prompt passes without resume; the body cap can't hold a RunStart at its field caps;
// - a deferred input or a usage over its cap passes;
// - negotiation picks a version one side doesn't speak;
// - /health from a runner that doesn't count quarantined users yet fails the parse, or a bad count passes.
// v2 (P3 R3), also written first:
// - a v2 message written by hand (bytes in fixtures/v2, not made by these encoders) fails to parse, or parses to
//   something other than what it says; a v1 message (fixtures/v1) still parses;
// - a resume without `expect`, or a first run with one, passes; `lastUuid` without its index (or past `mainEntries`)
//   passes; a system prompt over 64 KB of UTF-8, an 11th attachment or one outside `inputs/` passes;
// - a push batch mixes runs, skips or repeats a seq, is empty or over its cap; a status says unknown with seqs, or acked
//   past its last seq; a refusal code outside the four, or with a status other than its own.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import {
  ACCEPTED_VERSIONS,
  ATTACHMENTS_MAX,
  AuditPost,
  PUSH_BATCH_MAX_EVENTS,
  PushAck,
  PushBatch,
  RUN_REFUSAL_STATUS,
  RunAdmission,
  RunRefusal,
  RunStatus,
  SYSTEM_PROMPT_MAX_BYTES,
  DEFERRED_INPUT_MAX_BYTES,
  Health,
  PROMPT_MAX_CHARS,
  PROTOCOL_VERSION,
  RUN_START_MAX_BYTES,
  RunEventBody,
  USAGE_MAX_BYTES,
  RunStart,
  acceptsVersion,
  encodeRunEvent,
  negotiateVersion,
  parseRunEvent,
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
  sideModel: fc.constant('claude-haiku-5-5'),
  systemPrompt: fc.string({ maxLength: 200 }),
  attachments: fc.array(fc.stringMatching(/^[a-z0-9-]{1,20}\.pdf$/).map((n) => `inputs/${n}`), { maxLength: ATTACHMENTS_MAX }),
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
const uuid = fc.uuid({ version: 4 })
/** A store state: `lastUuid` and its index both null, or both set with the index inside `mainEntries`. */
const stateArb = (min: number) =>
  fc.integer({ min, max: 10_000 }).chain((mainEntries) =>
    mainEntries === 0
      ? fc.constant({ mainEntries, lastUuid: null, lastUuidIndex: null })
      : fc.oneof(
          fc.constant({ mainEntries, lastUuid: null, lastUuidIndex: null }),
          fc.record({ mainEntries: fc.constant(mainEntries), lastUuid: uuid as fc.Arbitrary<string | null>, lastUuidIndex: fc.nat(mainEntries - 1) as fc.Arbitrary<number | null> }),
        ),
  )
// `resume` is free except that an empty prompt needs it; `expect` is set exactly on a resume.
const runStartArb: fc.Arbitrary<RunStart> = fc
  .tuple(runStartFields, fc.boolean(), stateArb(1))
  .map(([s, resume, state]) => {
    const r = s.prompt === '' ? true : resume
    return { ...s, resume: r, expect: r ? state : null }
  })

const reason = fc.constantFrom('session_crashed', 'protocol', 'store', 'files', 'interrupted', 'stopped', 'timeout', 'sdk_error' as const)
const bodyArb: fc.Arbitrary<RunEventBody> = fc.oneof(
  fc.record({ type: fc.constant('started' as const), sessionId: fc.uuid({ version: 4 }), resume: fc.boolean() }),
  // z.record drops an own `__proto__` key (safe, and intended), so the round trip leaves it out of the generators.
  fc.record({ type: fc.constant('sdk' as const), message: fc.dictionary(fc.string().filter((k) => k !== '__proto__'), fc.jsonValue()), truncated: fc.boolean() }),
  fc.record({ type: fc.constant('file_saved' as const), path: fc.string({ maxLength: 50 }), bytes: fc.nat(), contentType: fc.constant('application/pdf'), sha256: fc.stringMatching(/^[0-9a-f]{64}$/) }),
  fc.record({ type: fc.constant('file_refused' as const), path: fc.string({ maxLength: 50 }), reason: fc.constantFrom('too_large', 'too_many', 'type_not_allowed', 'save_failed', 'bad_name' as const) }),
  fc.record({ type: fc.constant('files_restored' as const), restored: fc.nat(), bytes: fc.nat(), leftOut: fc.array(fc.string({ maxLength: 50 }), { maxLength: 5 }) }),
  fc.record({
    type: fc.constant('audit' as const),
    entry: fc.record({ hook: fc.constantFrom('PreToolUse', 'PostToolUse'), toolName: fc.string({ maxLength: 40 }), toolUseId: fc.string({ maxLength: 40 }), decision: fc.constantFrom('allow', 'deny', 'defer'), input: fc.jsonValue({ maxDepth: 3 }) }, { requiredKeys: ['hook', 'toolName', 'decision', 'input'] }),
  }),
  fc.record({ type: fc.constant('mirror_error' as const), message: fc.string({ maxLength: 100 }) }),
  fc.record({ type: fc.constant('deferred' as const), toolUseId: fc.string({ maxLength: 40 }), toolName: fc.string({ maxLength: 40 }), input: fc.jsonValue() }),
  fc.tuple(stateArb(0), fc.nat()).map(([state, runEntries]) => ({ type: 'checkpoint' as const, ...state, runEntries })),
  fc.constant({ type: 'heartbeat' as const }),
  fc.record({ type: fc.constant('released' as const), checkpoint: fc.option(stateArb(0), { nil: null }), queryRan: fc.boolean() }),
  fc.record({
    type: fc.constant('finished' as const),
    subtype: fc.constantFrom('success', 'error_max_turns'),
    isError: fc.boolean(),
    numTurns: fc.nat(),
    costUsd: fc.double({ min: 0, max: 100, noNaN: true }),
    usage: fc.dictionary(fc.string().filter((k) => k !== '__proto__'), fc.nat()),
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
    const expectState = { mainEntries: 1, lastUuid: null, lastUuidIndex: null }
    expect(RunStart.safeParse({ ...start, prompt: '', resume: true, expect: expectState }).success).toBe(true)
    const refused = RunStart.safeParse({ ...start, prompt: '', resume: false, expect: null })
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
      sideModel: 'h'.repeat(128),
      // One byte of UTF-8 each, six in JSON.
      systemPrompt: '\u0001'.repeat(SYSTEM_PROMPT_MAX_BYTES),
      attachments: Array.from({ length: ATTACHMENTS_MAX }, () => `inputs/${'\u0001'.repeat(1024 - 7)}`),
      expect: { mainEntries: Number.MAX_SAFE_INTEGER, lastUuid: '\u0001'.repeat(256), lastUuidIndex: Number.MAX_SAFE_INTEGER - 1 },
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
    const ok = { runId: 'r', type: 'heartbeat' }
    expect(() => parseRunEventLine(JSON.stringify({ ...ok, seq: -1 }))).toThrow()
    expect(() => parseRunEventLine(JSON.stringify({ ...ok, seq: 1.5 }))).toThrow()
    expect(() => parseRunEventLine(JSON.stringify({ ...ok, seq: 0, type: 'mystery' }))).toThrow()
  })
})

describe('versions', () => {
  it('v2 accepts only itself: v1 was never deployed, so current-and-previous starts at v2', () => {
    expect(PROTOCOL_VERSION).toBe(2)
    expect(ACCEPTED_VERSIONS).toEqual([2])
    expect(acceptsVersion('2')).toBe(true)
    expect(acceptsVersion('1')).toBe(false)
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

describe('health', () => {
  const memory = { totalBytes: null, availableBytes: 1, rssBytes: 1, heapUsedBytes: 1 }
  const health = { ok: true, protocol: PROTOCOL_VERSION, live: 0, memory }

  it("an older runner's answer, without the quarantined count, still parses; with it, the count comes through", () => {
    expect(Health.parse(health).quarantinedUsers).toBeUndefined()
    expect(Health.parse({ ...health, quarantinedUsers: 3 }).quarantinedUsers).toBe(3)
  })

  it('refuses a count that is not a whole number from 0 up, and an unknown field', () => {
    for (const bad of [-1, 1.5, '3', null]) expect(Health.safeParse({ ...health, quarantinedUsers: bad }).success, String(bad)).toBe(false)
    expect(Health.safeParse({ ...health, quarantined: 1 }).success).toBe(false)
  })
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

// ---- v2 (P3 R3)

const fixtures = (version: 'v1' | 'v2') => {
  const dir = fileURLToPath(new URL(`./fixtures/${version}/`, import.meta.url))
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, text: readFileSync(dir + f, 'utf8') }))
}
/** Each fixture file names its schema by the part of its name before the first dot. */
const parserFor = (name: string): ((raw: unknown) => unknown) => {
  const kind = name.split('.')[0]!
  const parsers: Record<string, (raw: unknown) => unknown> = {
    'run-start': (r) => RunStart.parse(r),
    event: (r) => parseRunEvent(r),
    'push-batch': (r) => PushBatch.parse(r),
    'push-ack': (r) => PushAck.parse(r),
    'audit-post': (r) => AuditPost.parse(r),
    'run-status': (r) => RunStatus.parse(r),
    'run-admission': (r) => RunAdmission.parse(r),
    'run-refusal': (r) => RunRefusal.parse(r),
  }
  const p = parsers[kind]
  if (!p) throw new Error(`no schema for fixture ${name}`)
  return p
}

describe('v2 wire fixtures (written by hand)', () => {
  const v2 = fixtures('v2')
  it('every v2 fixture parses to exactly what its bytes say', () => {
    expect(v2.length).toBeGreaterThanOrEqual(19)
    for (const f of v2) expect(parserFor(f.name)(JSON.parse(f.text)), f.name).toEqual(JSON.parse(f.text))
  })

  it('every v1 fixture is refused', () => {
    const v1 = fixtures('v1')
    expect(v1.map((f) => f.name).sort()).toEqual(['event.checkpoint.json', 'event.file_saved.json', 'run-start.json'])
    for (const f of v1) expect(() => parserFor(f.name)(JSON.parse(f.text)), f.name).toThrow()
  })
})

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/v2/${name}`, import.meta.url)), 'utf8')) as Record<string, unknown>

describe('RunStart v2 limits', () => {
  const first = fixture('run-start.first.json')
  const resume = fixture('run-start.resume.json')
  const ok = (v: Record<string, unknown>) => RunStart.safeParse(v).success

  it('expect is required on a resume and refused on a first run', () => {
    expect(ok({ ...resume, expect: null })).toBe(false)
    expect(ok({ ...first, expect: resume.expect })).toBe(false)
    const { expect: _, ...noKey } = resume
    expect(ok(noKey)).toBe(false)
  })

  it('expect: mainEntries from 1, lastUuid and lastUuidIndex together, the index inside mainEntries', () => {
    const e = (over: Record<string, unknown>) => ok({ ...resume, expect: { mainEntries: 12, lastUuid: 'u', lastUuidIndex: 11, ...over } })
    expect(e({})).toBe(true)
    expect(e({ mainEntries: 0, lastUuid: null, lastUuidIndex: null })).toBe(false)
    expect(e({ mainEntries: 1, lastUuid: null, lastUuidIndex: null })).toBe(true)
    expect(e({ lastUuid: null })).toBe(false)
    expect(e({ lastUuidIndex: null })).toBe(false)
    expect(e({ lastUuidIndex: 12 })).toBe(false)
    expect(e({ lastUuidIndex: 0 })).toBe(true)
    expect(e({ lastUuidIndex: -1 })).toBe(false)
    expect(e({ lastUuidIndex: 1.5 })).toBe(false)
    expect(e({ lastUuid: '' })).toBe(false)
    expect(e({ lastUuid: 'x'.repeat(257) })).toBe(false)
    expect(e({ extra: 1 })).toBe(false)
  })

  it('systemPrompt: at most 64 KB of UTF-8 (bytes, not characters)', () => {
    expect(ok({ ...first, systemPrompt: '' })).toBe(true)
    expect(ok({ ...first, systemPrompt: 'a'.repeat(65_536) })).toBe(true)
    expect(ok({ ...first, systemPrompt: 'a'.repeat(65_537) })).toBe(false)
    // 'é' is two bytes: 32,768 of them is the cap, one more is over (while far under 64K characters).
    expect(ok({ ...first, systemPrompt: 'é'.repeat(32_768) })).toBe(true)
    expect(ok({ ...first, systemPrompt: 'é'.repeat(32_768) + 'a' })).toBe(false)
  })

  it('attachments: at most 10, each under inputs/', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `inputs/f_${i}-a.pdf`)
    expect(ok({ ...first, attachments: paths(10) })).toBe(true)
    expect(ok({ ...first, attachments: paths(11) })).toBe(false)
    expect(ok({ ...first, attachments: ['outputs/a.pdf'] })).toBe(false)
    expect(ok({ ...first, attachments: ['a.pdf'] })).toBe(false)
    expect(ok({ ...first, attachments: [`inputs/${'a'.repeat(1017)}`] })).toBe(true)
    expect(ok({ ...first, attachments: [`inputs/${'a'.repeat(1018)}`] })).toBe(false)
  })

  it('sideModel follows the model rule', () => {
    expect(ok({ ...first, sideModel: 'claude-haiku-5-5' })).toBe(true)
    expect(ok({ ...first, sideModel: '' })).toBe(false)
    expect(ok({ ...first, sideModel: 'm'.repeat(129) })).toBe(false)
    expect(ok({ ...first, sideModel: 'claude haiku' })).toBe(false)
  })
})

describe('v2 events', () => {
  const body = (v: Record<string, unknown>) => RunEventBody.safeParse(v).success

  it('file_saved needs a lower-case hex SHA-256', () => {
    const f = { type: 'file_saved', path: 'outputs/a.pdf', bytes: 1, contentType: 'application/pdf' }
    expect(body({ ...f, sha256: 'a'.repeat(64) })).toBe(true)
    expect(body(f)).toBe(false)
    expect(body({ ...f, sha256: 'A'.repeat(64) })).toBe(false)
    expect(body({ ...f, sha256: 'a'.repeat(63) })).toBe(false)
  })

  it('checkpoint and released: lastUuid and its index together, inside mainEntries', () => {
    const cp = (over: Record<string, unknown>) => body({ type: 'checkpoint', mainEntries: 3, lastUuid: 'u', lastUuidIndex: 2, runEntries: 1, ...over })
    expect(cp({})).toBe(true)
    expect(cp({ lastUuidIndex: 3 })).toBe(false)
    expect(cp({ lastUuid: null })).toBe(false)
    expect(cp({ runEntries: -1 })).toBe(false)
    expect(cp({ mainEntries: 0, lastUuid: null, lastUuidIndex: null })).toBe(true)
    const rel = (checkpoint: unknown) => body({ type: 'released', checkpoint, queryRan: true })
    expect(rel(null)).toBe(true)
    expect(rel({ mainEntries: 3, lastUuid: 'u', lastUuidIndex: 2 })).toBe(true)
    expect(rel({ mainEntries: 3, lastUuid: 'u', lastUuidIndex: 3 })).toBe(false)
    expect(rel({ mainEntries: 3, lastUuid: 'u', lastUuidIndex: 2, runEntries: 1 })).toBe(false)
    expect(body({ type: 'released', checkpoint: null })).toBe(false)
    expect(body({ type: 'heartbeat', at: 1 })).toBe(false)
  })
})

describe('push, audit, status and admission', () => {
  const ev = (seq: number, runId = 't_a') => ({ runId, seq, type: 'heartbeat' })
  const batch = (events: unknown[]) => PushBatch.safeParse({ turnId: 't_a', events }).success

  it.prop([fc.nat(1e6), fc.integer({ min: 1, max: PUSH_BATCH_MAX_EVENTS })])('a batch of consecutive seqs of its own run, 1 to the cap, parses', (from, n) => {
    expect(batch(Array.from({ length: n }, (_, i) => ev(from + i)))).toBe(true)
  })

  it('a batch that is empty, over the cap, mixes runs, or skips, repeats or reverses a seq is refused', () => {
    expect(batch([])).toBe(false)
    expect(batch(Array.from({ length: PUSH_BATCH_MAX_EVENTS + 1 }, (_, i) => ev(i)))).toBe(false)
    expect(batch([ev(0), ev(1, 't_b')])).toBe(false)
    expect(batch([ev(0), ev(2)])).toBe(false)
    expect(batch([ev(0), ev(0)])).toBe(false)
    expect(batch([ev(1), ev(0)])).toBe(false)
    expect(batch([{ ...ev(0), extra: 1 }])).toBe(false)
    expect(PushBatch.safeParse({ turnId: 't_a', events: [ev(0)], extra: 1 }).success).toBe(false)
  })

  it('an ack needs a whole ackSeq from 0 and stop', () => {
    expect(PushAck.safeParse({ ackSeq: 0, stop: false }).success).toBe(true)
    expect(PushAck.safeParse({ ackSeq: -1, stop: false }).success).toBe(false)
    expect(PushAck.safeParse({ ackSeq: 1 }).success).toBe(false)
  })

  it('an audit post needs a whole n from 0 and a valid entry', () => {
    const a = fixture('audit-post.json')
    expect(AuditPost.safeParse({ ...a, n: -1 }).success).toBe(false)
    expect(AuditPost.safeParse({ ...a, n: 0.5 }).success).toBe(false)
    expect(AuditPost.safeParse({ ...a, entry: { hook: 'PreToolUse' } }).success).toBe(false)
    expect(AuditPost.safeParse({ ...a, turnId: 'a b' }).success).toBe(false)
  })

  it('a status: unknown carries no seqs, and nothing is acked past the last seq', () => {
    const st = (v: Record<string, unknown>) => RunStatus.safeParse(v).success
    expect(st({ state: 'unknown', lastSeq: 3, ackedSeq: null })).toBe(false)
    expect(st({ state: 'running', lastSeq: 3, ackedSeq: 4 })).toBe(false)
    expect(st({ state: 'running', lastSeq: null, ackedSeq: 0 })).toBe(false)
    expect(st({ state: 'released', lastSeq: 9, ackedSeq: 9 })).toBe(true)
    expect(st({ state: 'ending', lastSeq: 9, ackedSeq: null })).toBe(true)
    expect(st({ state: 'gone', lastSeq: null, ackedSeq: null })).toBe(false)
  })

  it('admission is { accepted: true } only; each refusal code has its own status', () => {
    expect(RunAdmission.safeParse({ accepted: false }).success).toBe(false)
    expect(RunAdmission.safeParse({ ok: true }).success).toBe(false)
    expect(RUN_REFUSAL_STATUS).toEqual({ session_pool_exhausted: 503, session_folder_parked: 503, chat_live: 409, run_live: 409 })
    expect(RunRefusal.safeParse({ error: 'the runner is stopping' }).success).toBe(false)
  })
})
