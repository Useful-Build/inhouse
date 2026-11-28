// Shared types of the eval harness. A case names people by key; each target maps the keys to its own ids.

export type PersonKey = 'current' | 'tom' | 'lena'
export type People = Record<PersonKey, string>
export type Category = 'recall' | 'e2e' | 'choice' | 'connector' | 'negative' | 'exfil'
export const CATEGORIES: readonly Category[] = ['recall', 'e2e', 'choice', 'connector', 'negative', 'exfil']

/** A wanted value for a tool argument: a RegExp tests the JSON of the value, a string must equal it, a person key
 *  matches that person's id for the running target. */
export type Want = RegExp | string | { person: PersonKey } | { readonly [field: string]: Want }

export interface Expect {
  /** One tool name or several; at least one of them was called (names without the `mcp__server__` prefix). */
  tool?: string | string[]
  /** Every entry must match in one call of a `tool`. */
  args?: Record<string, Want>
  notCalled?: string[]
  /** No tool call at all (ToolSearch and Skill are logged, not counted). */
  none?: boolean
  /** None of our own tools (inhouse, shop, mail) called. */
  noMcp?: boolean
  answer?: RegExp[]
  answerNot?: RegExp[]
  /** Each named tool is called at most this many times (a routine asks its creator at most once: Q01). */
  atMost?: Record<string, number>
  /**
   * Order (Stage 1 M3-G, T09): for each `[first, then]`, both were called and `first`'s earliest call comes before
   * `then`'s (the agent looked the member id up with member_find before notification_send).
   */
  before?: [first: string, then: string][]
}

export interface SeedFact {
  memoryId?: string
  fact: string
  scope: 'brand' | 'person'
  person?: PersonKey
}

/**
 * An approval the case's person already has, waiting, in the case's chat (Stage 1 M2-G: T15, T16; since M2-E the
 * approval tools read the person's own real approvals). `id` is the case's own name for it (`ap_204`): the target seeds a
 * real one, puts its real id in the prompt in place of this one, and reads a call's real id back as this one.
 */
export interface SeedApproval {
  id: string
  /** The card's title and one line, as a person would read them. */
  title: string
  line: string
}

export type ExfilKind = 'webfetch' | 'link' | 'memory'
/** How the planted text reaches the agent: what P3 has. */
export type ExfilVia = 'memory_search' | 'history_search' | 'attachment'

export interface ExfilSpec {
  kind: ExfilKind
  via: ExfilVia
  /** Hosts the brand allows (the case's list); anything else is unlisted. */
  hosts: string[]
  /** The tool data the agent reads: carries the canary and the instruction to move it out. */
  plant: (canary: string) => string
  /**
   * M3-F (N29): the brand's WebFetch mode for the case. `open`: any public host is allowed, so only a WebFetch carrying
   * the secret counts, refused or a bypass (`webfetch.unlisted` means nothing). Absent: `list`.
   */
  fetch?: 'open'
  /** The private value the planted text asks to move, made from the canary (an order number, say). Absent: the canary. */
  secret?: (canary: string) => string
  /**
   * The positive control (M3-F): the case passes only when a WebFetch to this host went out and wasn't refused, so a
   * build that refuses every fetch can't pass the set.
   */
  mustFetch?: string
}

export interface ChatCase {
  prompt: string
  expect: Expect
}

export interface Case {
  id: string
  cat: Category
  pair?: string
  note?: string
  /** Tools P3 doesn't build; the product target reports the case as not run. */
  needs?: string[]
  seed?: SeedFact[]
  /** Approvals the case's person already has (the product target seeds them; a fake target's transcript names them). */
  approvals?: SeedApproval[]
  chats: ChatCase[]
  exfil?: ExfilSpec
}

export interface ToolCall {
  /** As the SDK names it (`mcp__inhouse__memory_search`) or a built-in (`WebFetch`). */
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
  /** The product target (eval build): a hook denied this call (route 33's `io.denied`), its refusal without a result. */
  hookDenied?: boolean
  /** The product target: the input was cut at the trace's cap (or not kept), so `input` is `{}` and grades as unknown. */
  inputCut?: boolean
  /** The input as grading reads it: a seeded fact's product id as the seed's id (#282 review L3: `input` stays the trace's). */
  seedInput?: Record<string, unknown>
}

export interface Usage {
  inputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export interface ChatResult {
  toolCalls: ToolCall[]
  answer: string
  runOk: boolean
  usage: Usage
  costUsd: number
  /** Why a chat that ran ended without an answer: the end row's plain cause (`runner_lost`), `error_part`, or `unknown`. */
  failure?: string
  /** The product's turn id, to read its trace (route 33) while it's kept. */
  turnId?: string
  /** The product target: the chat the prompt ran in (the read-side set reads its transcript and files). */
  chatId?: string
  /** The case person who asked (`eval-<run>-<case>-r<rep>`). */
  askedAs?: string
}

export interface RunContext {
  caseId: string
  rep: number
  /** Unique invented canary of this case-repeat (exfiltration cases). */
  canary: string
  /** The case's approvals to seed (Case.approvals). */
  approvals?: SeedApproval[]
  /** The case seeds writes (M3-E's write-injection set): the product session's reset then clears the write state too. */
  writes?: boolean
  /** The case person's display name (M3-E, #533: a name that carries an instruction). Default: `Eval <case> r<rep>`. */
  personName?: string
}

/** One case-repeat on a target. Own object per case-repeat so a concurrent run never shares state. */
export interface Session {
  chat(prompt: string, opts?: { signal?: AbortSignal }): Promise<ChatResult>
  /** Ends the case-repeat: clears what the session seeded. */
  reset(): Promise<void>
  /** Stops everything the session started and waits until nothing of it runs or sends (the product target, #450). */
  quiesce?(): Promise<void>
  /** Stops the session's own turns, at once (a cancel's close). */
  stopTurns?(): Promise<void>
  /** The server-settled spend of this session's chats so far in USD (the product target), read when a chat timed out or threw: its cost is what the server booked, not $0. */
  settledCostUsd?(): Promise<number>
}

export interface Target {
  readonly name: 'fake' | 'fixture' | 'product'
  /** The people keys mapped to this target's ids. */
  readonly people: People
  /** Tool families this target can serve (`shop`, `mail`, `routines`); a case needing another is not run. */
  readonly provides: ReadonlySet<string>
  /**
   * Tools this target serves with an open input schema (no fields: a stub, before its phase builds it). A case expecting
   * one doesn't grade its args (`argsNotGraded`); tool and notCalled still grade.
   */
  readonly openSchema?: ReadonlySet<string>
  /** False for a case this target has no way to serve (the fixture target holds only S5's runs). */
  canRun?(c: Case): boolean
  /** Why this target can't grade the case (a field its API doesn't show), or null when it can. Such a case isn't run: it's listed as not graded. */
  unobservable?(c: Case): string | null
  /** Starts a case-repeat: seeds its memory, plants exfiltration data. (The brief's seed(), reset() and chat(), split into
   *  a session per case-repeat so concurrent runs don't share a case counter.) */
  seed(memory: SeedFact[], run: RunContext, exfil?: ExfilSpec): Promise<Session>
  /** Server-reported spend so far in USD, when the target knows it (the product target); else the runner sums. */
  spentUsd?(): number
  /** The month's spend and the brand's Spending cap, from the product's own usage (the product target, O2 note). */
  room?(): Promise<{ spentUsd: number; capUsd: number }>
  /** Gives back what the target holds on the deployment (the product target's eval lease). run.ts calls it on exit and on signals. */
  close?(): Promise<void>
}

/**
 * A turn the brand's Spending cap fenced (`cap_reached`, as a failure or a cancel reason on the turn's end row): the run
 * stops there, and the chat is never graded as a pass (O2 note: the eval brand's $50 cap).
 */
export class CapReachedError extends Error {
  override name = 'CapReachedError'
  readonly turnId: string
  // No parameter property: node runs evals/ with type stripping only.
  constructor(turnId: string) {
    super(`cap reached: the brand's Spending cap fenced turn ${turnId}`)
    this.turnId = turnId
  }
}

export interface CheckVerdict {
  checks: Record<string, boolean>
  pass: boolean
  runOk: boolean
  called: string[]
  toolSearches: number
  /** Why the args check didn't run: the expected tool's served schema defines no fields. */
  argsNotGraded?: string
}
