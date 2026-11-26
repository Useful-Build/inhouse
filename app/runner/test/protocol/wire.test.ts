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
//   something other than what it says; a v1 message (fixtures/v1) parses, or is refused for some other reason than the
//   field v2 changed (v1 is refused: ACCEPTED_VERSIONS is [2]);
// - a resume without `expect`, or a first run with one, passes; `lastUuid` without its index (or past `mainEntries`)
//   passes; a system prompt over 64 KB of UTF-8, an 11th attachment, one outside `inputs/`, one the files route can't
//   carry (a `.`, `..` or empty segment, `#`, `\`) or one named twice passes;
// - an empty store (`mainEntries: 0`) is refused in a checkpoint or `released`, or passes with a uuid or an index;
// - an sdk message over SDK_MESSAGE_MAX_BYTES passes; a batch at PUSH_BATCH_MAX_BYTES (events at the buffer's cap, the
//   most events, the longest turn id) is refused, or the body cap is smaller than such a batch;
// - a push batch mixes runs, skips or repeats a seq, is empty or over its cap; a status says unknown with seqs, or acked
//   past its last seq; a refusal code outside the four, or with a status other than its own.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import {
  ACCEPTED_VERSIONS,
  OUTPUT_SCHEMA_MAX_BYTES,
  STRUCTURED_MAX_DEPTH,
  STRUCTURED_OUTPUT_MAX_BYTES,
  jsonDepth,
  ATTACHMENTS_MAX,
  AuditPost,
  PUSH_BATCH_MAX_BYTES,
  PUSH_BATCH_MAX_EVENTS,
  PUSH_BUFFER_MAX_BYTES,
  SDK_MESSAGE_MAX_BYTES,
  PushAck,
  PushBatch,
  RUN_REFUSAL_STATUS,
  RunAdmission,
  RunRefusal,
  RunStatus,
  SYSTEM_PROMPT_MAX_BYTES,
  DEFERRED_INPUT_MAX_BYTES,
  BRAND_SKILLS_VERSION,
  HELPERS_VERSION,
  HELPER_DESCRIPTION_MAX_BYTES,
  HELPER_PROMPT_MAX_BYTES,
  auditInputSha256,
  canonicalJson,
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
import { BRAND_SKILL_BODY_MAX, BRAND_SKILLS_BYTES_MAX } from '../../../shared/protocol/brand-skills.ts'

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
  attachments: fc.uniqueArray(fc.stringMatching(/^[a-z0-9-]{1,20}\.pdf$/).map((n) => `inputs/${n}`), { maxLength: ATTACHMENTS_MAX }),
  effort: fc.constantFrom('low', 'medium', 'high', 'xhigh', 'max'),
  maxTurns: fc.integer({ min: 1, max: 500 }),
  maxBudgetUsd: fc.double({ min: 0.01, max: 1000, noNaN: true }),
  runToken: fc.stringMatching(/^[\x21-\x7e]{16,64}$/),
  webFetchDomains: fc.option(fc.array(fc.domain().map((d) => d.toLowerCase()), { maxLength: 4 }), { nil: null }),
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

  // outputFormat, webSearch and brandSkills are the optional fields (v2, additive: structured output; P8a S, absent is off),
  // and Stage 1's agents, subagentModel and actions (N6, additive the same way).
  const OPTIONAL_START_KEYS = ['outputFormat', 'webSearch', 'brandSkills', 'agents', 'subagentModel', 'actions']
  it.prop([runStartArb, fc.constantFrom(...Object.keys(RunStart.shape).filter((k) => !OPTIONAL_START_KEYS.includes(k)))])('refuses a missing field', (start, key) => {
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

  // Stage 1 (N6), ways the helpers' keys can go wrong, written first: a third helper or a missing one rides in, a helper
  // brings its own tools or model (the runner owns both), its words carry a control character (JSON's six-byte escape
  // would break the body cap) or pass their byte caps, `actions` isn't a boolean, or a model name the start's own rule
  // refuses.
  it('takes the helpers, the subagent model and the actions switch only in their frozen shape', () => {
    const start = fc.sample(runStartArb, 1)[0]!
    expect(start).not.toHaveProperty('subagentModel')
    const helper = { description: 'Finds facts on the web.', prompt: 'You research.\n\tCite every source.' }
    const agents = { researcher: helper, analyst: helper }
    const parses = (extra: Record<string, unknown>) => RunStart.safeParse({ subagentModel: 'claude-sonnet-5-5', ...start, ...extra }).success
    expect(parses({ agents, actions: true })).toBe(true)
    expect(parses({ subagentModel: undefined, actions: false })).toBe(true)
    // agents and subagentModel come together.
    expect(parses({ subagentModel: undefined, agents })).toBe(false)
    expect(parses({})).toBe(false)
    expect(parses({ agents: { researcher: helper } })).toBe(false)
    expect(parses({ agents: { ...agents, writer: helper } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, tools: ['Bash'] } } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, model: 'opus' } } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, prompt: 'a\u0001b' } } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, prompt: '' } } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, prompt: 'x'.repeat(HELPER_PROMPT_MAX_BYTES + 1) } } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, prompt: '€'.repeat(Math.floor(HELPER_PROMPT_MAX_BYTES / 3) + 1) } } })).toBe(false)
    expect(parses({ agents: { ...agents, analyst: { ...helper, description: 'x'.repeat(HELPER_DESCRIPTION_MAX_BYTES + 1) } } })).toBe(false)
    expect(parses({ agents, actions: 'yes' })).toBe(false)
    expect(parses({ agents, subagentModel: 'bad model' })).toBe(false)
  })

  /** A 1,024-character path under `inputs/` from segments of at most 255 UTF-8 bytes ('€' is three), `first` leading. */
  const longPath = (first: string) => {
    let path = `inputs/${first}${'€'.repeat(85 - first.length)}`
    while (path.length < 1024) path += `/${'€'.repeat(Math.min(85, 1024 - path.length - 1))}`
    return path
  }

  it('a RunStart at every field cap, its prompt written in the longest escapes, fits the body cap', () => {
    expect(longPath('0')).toHaveLength(1024)
    expect(longPath('0').split('/').slice(1).every((s) => new TextEncoder().encode(s).length <= 255)).toBe(true)
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
      // Each unique (a digit first) and 1,024 characters long. A file name can't hold a control character (six bytes in
      // JSON) or a segment over 255 UTF-8 bytes, so the longest JSON per character is a three-byte one ('€'), 85 to a
      // 255-byte segment.
      attachments: Array.from({ length: ATTACHMENTS_MAX }, (_, i) => longPath(`${i}`)),
      expect: { mainEntries: Number.MAX_SAFE_INTEGER, lastUuid: '\u0001'.repeat(256), lastUuidIndex: Number.MAX_SAFE_INTEGER - 1 },
      effort: 'medium',
      maxTurns: 500,
      maxBudgetUsd: 1000,
      runToken: '!'.repeat(512),
      webFetchDomains: Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'a'.repeat(57)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`),
      fileCaps: { maxFileBytes: 1e15, maxFilesPerTurn: 1e15, maxRestoreBytes: 1e15, allowedTypes: Array.from({ length: 64 }, () => `application/${'x'.repeat(100)}`) },
      // v3: the brand skills at their byte budget, every character a quote (one byte of UTF-8, two in JSON: the most a
      // character allowed in them gets). 16 bodies at the body cap, the rest of the budget in the descriptions.
      brandSkills: Array.from({ length: 16 }, (_, i) => ({
        name: `s-${String(i).padStart(2, '0')}`,
        description: '"'.repeat(Math.floor((BRAND_SKILLS_BYTES_MAX - 16 * BRAND_SKILL_BODY_MAX - 16 * 4) / 16)),
        body: '"'.repeat(BRAND_SKILL_BODY_MAX),
      })),
      // Stage 1 (N6): both helpers at their caps, every character a quote (two bytes in JSON, the most allowed), and the
      // longest model name.
      agents: {
        researcher: { description: '"'.repeat(HELPER_DESCRIPTION_MAX_BYTES), prompt: '"'.repeat(HELPER_PROMPT_MAX_BYTES) },
        analyst: { description: '"'.repeat(HELPER_DESCRIPTION_MAX_BYTES), prompt: '"'.repeat(HELPER_PROMPT_MAX_BYTES) },
      },
      subagentModel: 's'.repeat(128),
      actions: false,
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
  it('v3 accepts itself and v2 (current and previous; v1 was never deployed)', () => {
    expect(PROTOCOL_VERSION).toBe(3)
    expect(ACCEPTED_VERSIONS).toEqual([3, 2])
    expect(acceptsVersion('3')).toBe(true)
    expect(acceptsVersion('2')).toBe(true)
    expect(acceptsVersion('1')).toBe(false)
  })

  // Stage 1 (W0-A): the helper, actions and audit keys are gated on v4, which no side speaks yet, so no Worker or runner
  // can send them to a peer whose strict schema would refuse them. M1-E bumps to 4.
  it('the gates: brand skills from v3, the helper keys from v4 (above every accepted version for now)', () => {
    expect(BRAND_SKILLS_VERSION).toBe(3)
    expect(HELPERS_VERSION).toBe(4)
    expect(Math.max(...ACCEPTED_VERSIONS)).toBeLessThan(HELPERS_VERSION)
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

  it('an sdk message over its cap fails the parse; at the cap it passes', () => {
    const sized = (bytes: number) => ({ a: 'x'.repeat(bytes - 8) })
    const sdk = (message: Record<string, unknown>) => RunEventBody.safeParse({ type: 'sdk', message, truncated: false }).success
    expect(SDK_MESSAGE_MAX_BYTES).toBe(262_144)
    expect(sdk(sized(SDK_MESSAGE_MAX_BYTES))).toBe(true)
    expect(sdk(sized(SDK_MESSAGE_MAX_BYTES + 1))).toBe(false)
    // Bytes, not characters: 'é' is two.
    expect(sdk({ a: 'é'.repeat((SDK_MESSAGE_MAX_BYTES - 8) / 2) })).toBe(true)
    expect(sdk({ a: 'é'.repeat((SDK_MESSAGE_MAX_BYTES - 8) / 2) + 'x' })).toBe(false)
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
    expect(v2.length).toBeGreaterThanOrEqual(25)
    for (const f of v2) expect(parserFor(f.name)(JSON.parse(f.text)), f.name).toEqual(JSON.parse(f.text))
  })

  it('every v1 fixture is refused, on the field v2 changed', () => {
    const v1 = fixtures('v1')
    expect(v1.map((f) => f.name).sort()).toEqual(['event.checkpoint.json', 'event.file_saved.json', 'run-start.json'])
    /** The issues a parse threw: each issue's path, and the keys of an unrecognized-keys issue as `+key`. */
    const refusal = (name: string): string[] => {
      const f = v1.find((x) => x.name === name)!
      try {
        parserFor(name)(JSON.parse(f.text))
      } catch (e) {
        const issues = (e as { issues?: { path: PropertyKey[]; keys?: string[] }[] }).issues
        if (!issues) throw e
        return issues.flatMap((i) => [i.path.join('.'), ...(i.keys ?? []).map((k) => `+${k}`)])
      }
      throw new Error(`${name} parsed`)
    }
    expect(refusal('run-start.json')).toEqual(expect.arrayContaining(['sideModel', 'systemPrompt', 'attachments', 'expect']))
    expect(refusal('event.checkpoint.json')).toEqual(expect.arrayContaining(['+entries', 'mainEntries', 'lastUuid', 'lastUuidIndex', 'runEntries']))
    expect(refusal('event.file_saved.json')).toEqual(['sha256'])
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

  it('attachments: none the files route cannot carry, none twice', () => {
    expect(ok({ ...first, attachments: ['inputs/a.pdf', 'inputs/sub/b.pdf'] })).toBe(true)
    for (const bad of ['inputs/', 'inputs//a.pdf', 'inputs/./a.pdf', 'inputs/../a.pdf', 'inputs/..', 'inputs/.', 'inputs/a.pdf/', 'inputs/a#b.pdf', 'inputs/a\\b.pdf', 'inputs/\ud800.pdf']) {
      expect(ok({ ...first, attachments: [bad] }), bad).toBe(false)
    }
    expect(ok({ ...first, attachments: ['inputs/a.pdf', 'inputs/a.pdf'] })).toBe(false)
    expect(ok({ ...first, attachments: ['inputs/a.pdf', 'inputs/b.pdf', 'inputs/a.pdf'] })).toBe(false)
  })

  it('attachments: at most 10, each under inputs/', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `inputs/f_${i}-a.pdf`)
    expect(ok({ ...first, attachments: paths(10) })).toBe(true)
    expect(ok({ ...first, attachments: paths(11) })).toBe(false)
    expect(ok({ ...first, attachments: ['outputs/a.pdf'] })).toBe(false)
    expect(ok({ ...first, attachments: ['a.pdf'] })).toBe(false)
    // The path cap (1,024 characters) from segments at the 255-byte limit; one character more is refused.
    const at = (last: number) => `inputs/${'a'.repeat(255)}/${'a'.repeat(255)}/${'a'.repeat(255)}/${'a'.repeat(last)}`
    expect(at(249)).toHaveLength(1024)
    expect(ok({ ...first, attachments: [at(249)] })).toBe(true)
    expect(ok({ ...first, attachments: [at(250)] })).toBe(false)
    // A segment of 255 bytes is carried; 256 is refused (the shared name rule), also when the bytes are multi-byte.
    expect(ok({ ...first, attachments: [`inputs/${'a'.repeat(255)}`] })).toBe(true)
    expect(ok({ ...first, attachments: [`inputs/${'a'.repeat(256)}`] })).toBe(false)
    expect(ok({ ...first, attachments: [`inputs/${'é'.repeat(128)}`] })).toBe(false)
  })

  it('webFetchDomains: null (any public host), a list, or [] (none); never a missing key or a bad host', () => {
    expect(ok({ ...first, webFetchDomains: null })).toBe(true)
    expect(ok({ ...first, webFetchDomains: [] })).toBe(true)
    expect(ok({ ...first, webFetchDomains: ['docs.example.com'] })).toBe(true)
    const { webFetchDomains: _, ...missing } = first
    expect(ok(missing)).toBe(false)
    expect(ok({ ...first, webFetchDomains: ['localhost'] })).toBe(false)
    expect(ok({ ...first, webFetchDomains: '*' })).toBe(false)
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
    // An empty store has no last uuid and no index.
    expect(cp({ mainEntries: 0, lastUuid: 'u', lastUuidIndex: null })).toBe(false)
    expect(cp({ mainEntries: 0, lastUuid: null, lastUuidIndex: 0 })).toBe(false)
    expect(cp({ mainEntries: 0, lastUuid: 'u', lastUuidIndex: 0 })).toBe(false)
    const rel = (checkpoint: unknown) => body({ type: 'released', checkpoint, queryRan: true })
    expect(rel(null)).toBe(true)
    expect(rel({ mainEntries: 3, lastUuid: 'u', lastUuidIndex: 2 })).toBe(true)
    expect(rel({ mainEntries: 3, lastUuid: 'u', lastUuidIndex: 3 })).toBe(false)
    expect(rel({ mainEntries: 0, lastUuid: null, lastUuidIndex: null })).toBe(true)
    expect(rel({ mainEntries: 0, lastUuid: 'u', lastUuidIndex: null })).toBe(false)
    expect(rel({ mainEntries: 0, lastUuid: null, lastUuidIndex: 0 })).toBe(false)
    expect(rel({ mainEntries: 0, lastUuid: 'u', lastUuidIndex: 0 })).toBe(false)
    expect(rel({ mainEntries: 3, lastUuid: 'u', lastUuidIndex: 2, runEntries: 1 })).toBe(false)
    expect(body({ type: 'released', checkpoint: null })).toBe(false)
    expect(body({ type: 'heartbeat', at: 1 })).toBe(false)
  })
})

const SHA_A1_B12 = '8baa73198470c7bb4c3ce142a8fd651affc0310d878bb9bd159e37a573fb4874'

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

  it('a batch at the body cap (the most events, the longest turn id, events summing to the buffer cap) parses', () => {
    // 2 MiB of events plus 288 bytes of batch JSON around them, worked out by hand.
    expect(PUSH_BATCH_MAX_BYTES).toBe(2 * 1024 * 1024 + 288)
    const turnId = 't'.repeat(64)
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length
    const event = (seq: number, pad: string) => ({ runId: turnId, seq, type: 'sdk', message: { p: pad }, truncated: false })
    const n = PUSH_BATCH_MAX_EVENTS
    let left = PUSH_BUFFER_MAX_BYTES - Array.from({ length: n }, (_, i) => bytes(event(i, ''))).reduce((a, b) => a + b, 0)
    const events = Array.from({ length: n }, (_, i) => {
      const pad = i === n - 1 ? left : Math.floor(left / (n - i))
      left -= pad
      return event(i, 'x'.repeat(pad))
    })
    expect(events.reduce((a, e) => a + bytes(e), 0)).toBe(PUSH_BUFFER_MAX_BYTES)
    const body = { turnId, events }
    expect(bytes(body)).toBe(PUSH_BATCH_MAX_BYTES)
    expect(PushBatch.safeParse(body).success).toBe(true)
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

  // Stage 1 (N6, N14): who made the call and the hash of its input ride on the entry, optional; a malformed hash or an
  // empty helper id is refused, so the server never matches a proposal against a bad value.
  it('an audit entry takes an optional helper id and input hash, in their shapes only', () => {
    const a = fixture('audit-post.json') as { entry: Record<string, unknown> }
    const sha = 'a'.repeat(64)
    const entry = (extra: Record<string, unknown>) => AuditPost.safeParse({ ...a, entry: { ...a.entry, ...extra } }).success
    expect(entry({ agentId: 'agent-1', inputSha256: sha })).toBe(true)
    expect(entry({ agentId: null, inputSha256: sha })).toBe(true)
    // Together or not at all: a hash with no agentId would read as the main agent's call.
    expect(entry({ inputSha256: sha })).toBe(false)
    expect(entry({ agentId: null })).toBe(false)
    expect(entry({ agentId: '', inputSha256: sha })).toBe(false)
    expect(entry({ agentId: null, inputSha256: 'A'.repeat(64) })).toBe(false)
    expect(entry({ agentId: null, inputSha256: sha.slice(1) })).toBe(false)
  })

  // The one hash both sides compute (N14): key order and undefined keys never change it; values, array order and types do.
  it('auditInputSha256 is the SHA-256 of the canonical JSON', async () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, undefined, 1] } })).toBe('{"a":{"c":[2,null,1]},"b":1}')
    // sha256('{"a":1,"b":[1,2]}'), worked out with `printf %s '{"a":1,"b":[1,2]}' | shasum -a 256`.
    expect(await auditInputSha256({ b: [1, 2], a: 1 })).toBe(SHA_A1_B12)
    expect(await auditInputSha256({ a: 1, b: [1, 2], c: undefined })).toBe(SHA_A1_B12)
    expect(await auditInputSha256({ a: 1, b: [2, 1] })).not.toBe(SHA_A1_B12)
    expect(await auditInputSha256({ a: '1', b: [1, 2] })).not.toBe(SHA_A1_B12)
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

// Structured output (R3 follow-up). Ways it could fail: a schema or an output over its cap passes; an outputFormat with
// another type, or an extra key, passes; a cap counted in characters rather than UTF-8 bytes lets multibyte text past it;
// a schema or an output nested past 64 levels passes (the local channel would then refuse it), or a deep one throws; the
// failure code is missing.
// The WebSearch switch (P8a S). Ways it could fail: a run start without it (a Worker from before P8a) is refused, or a
// value other than a boolean passes.
describe('webSearch on the wire', () => {
  const first = fixture('run-start.first.json')
  it('optional; true or false only', () => {
    expect(RunStart.safeParse(first).success).toBe(true)
    for (const v of [true, false]) expect(RunStart.safeParse({ ...first, webSearch: v }).success).toBe(true)
    for (const v of ['true', 1, null, 'on']) expect(RunStart.safeParse({ ...first, webSearch: v }).success, String(v)).toBe(false)
  })
})

describe('structured output on the wire', () => {
  const first = fixture('run-start.first.json')
  const ok = (v: Record<string, unknown>) => RunStart.safeParse(v).success
  const sized = (bytes: number) => ({ a: 'x'.repeat(bytes - 8) })

  it('outputFormat: json_schema with a schema object up to 16 KB; optional', () => {
    expect(ok(first)).toBe(true)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: { type: 'object' } } })).toBe(true)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: sized(OUTPUT_SCHEMA_MAX_BYTES) } })).toBe(true)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: sized(OUTPUT_SCHEMA_MAX_BYTES + 1) } })).toBe(false)
    expect(ok({ ...first, outputFormat: { type: 'text', schema: {} } })).toBe(false)
    expect(ok({ ...first, outputFormat: { type: 'json_schema' } })).toBe(false)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: [] } })).toBe(false)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: {}, strict: true } })).toBe(false)
    expect(ok({ ...first, outputFormat: null })).toBe(false)
  })

  it('finished.structuredOutput: any JSON value up to 64 KB; optional', () => {
    const f = { type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} }
    const body = (v: Record<string, unknown>) => RunEventBody.safeParse(v).success
    expect(body(f)).toBe(true)
    for (const v of [{ a: 1 }, [1, 2], 'text', 0, false, null]) expect(body({ ...f, structuredOutput: v }), JSON.stringify(v)).toBe(true)
    expect(body({ ...f, structuredOutput: sized(STRUCTURED_OUTPUT_MAX_BYTES) })).toBe(true)
    expect(body({ ...f, structuredOutput: sized(STRUCTURED_OUTPUT_MAX_BYTES + 1) })).toBe(false)
  })

  // #151 review round 1: multibyte at the caps, and the depth cap.
  const multibyte = (bytes: number) => ({ a: 'é'.repeat((bytes - 8) / 2) })
  const multibyteOver = (bytes: number) => ({ a: `${'é'.repeat((bytes - 8) / 2)}x` })
  const nest = (n: number): unknown => (n === 0 ? 1 : [nest(n - 1)])
  const nestObject = (n: number): Record<string, unknown> => ({ a: n === 1 ? 1 : nestObject(n - 1) })

  it('the schema cap counts UTF-8 bytes: multibyte at 16 KB passes, one byte over fails', () => {
    expect(JSON.stringify(multibyteOver(OUTPUT_SCHEMA_MAX_BYTES)).length).toBeLessThan(OUTPUT_SCHEMA_MAX_BYTES)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: multibyte(OUTPUT_SCHEMA_MAX_BYTES) } })).toBe(true)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: multibyteOver(OUTPUT_SCHEMA_MAX_BYTES) } })).toBe(false)
  })

  it('the output cap counts UTF-8 bytes: multibyte at 64 KB passes, one byte over fails', () => {
    const f = { type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} }
    expect(JSON.stringify(multibyteOver(STRUCTURED_OUTPUT_MAX_BYTES)).length).toBeLessThan(STRUCTURED_OUTPUT_MAX_BYTES)
    expect(RunEventBody.safeParse({ ...f, structuredOutput: multibyte(STRUCTURED_OUTPUT_MAX_BYTES) }).success).toBe(true)
    expect(RunEventBody.safeParse({ ...f, structuredOutput: multibyteOver(STRUCTURED_OUTPUT_MAX_BYTES) }).success).toBe(false)
  })

  it('depth: a schema or an output 64 levels deep passes, 65 fails; 5000 deep is refused, never thrown', () => {
    const f = { type: 'finished', subtype: 'success', isError: false, numTurns: 1, costUsd: 0, usage: {} }
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: nestObject(64) } })).toBe(true)
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: nestObject(65) } })).toBe(false)
    expect(RunEventBody.safeParse({ ...f, structuredOutput: nest(64) }).success).toBe(true)
    expect(RunEventBody.safeParse({ ...f, structuredOutput: nest(65) }).success).toBe(false)
    let deep: Record<string, unknown> = { type: 'object' }
    for (let i = 0; i < 5000; i++) deep = { not: deep }
    expect(() => RunStart.safeParse({ ...first, outputFormat: { type: 'json_schema', schema: deep } })).not.toThrow()
    expect(ok({ ...first, outputFormat: { type: 'json_schema', schema: deep } })).toBe(false)
    expect(jsonDepth(nest(64))).toBe(64)
    expect(jsonDepth(nest(65))).toBe(65)
    expect(jsonDepth(nest(200))).toBe(STRUCTURED_MAX_DEPTH + 1)
    expect(jsonDepth('x')).toBe(0)
    expect(jsonDepth({})).toBe(1)
  })

  it('a failed run can say structured_output', () => {
    expect(RunEventBody.safeParse({ type: 'failed', reason: 'structured_output', message: 'x' }).success).toBe(true)
    expect(RunEventBody.safeParse({ type: 'failed', reason: 'structured', message: 'x' }).success).toBe(false)
  })
})
