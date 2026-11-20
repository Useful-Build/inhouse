// Shared types of the eval harness. A case names people by key; each target maps the keys to its own ids.

export type PersonKey = 'current' | 'tom' | 'lena'
export type People = Record<PersonKey, string>
export type Category = 'recall' | 'e2e' | 'choice' | 'connector' | 'negative' | 'exfil'
export const CATEGORIES: readonly Category[] = ['recall', 'e2e', 'choice', 'connector', 'negative', 'exfil']

/** A wanted value for a tool argument: a RegExp tests the JSON of the value, a string must equal it, a person key
 *  matches that person's id for the running target. */
export type Want = RegExp | string | { person: PersonKey }

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
}

export interface SeedFact {
  memoryId?: string
  fact: string
  scope: 'brand' | 'person'
  person?: PersonKey
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
  chats: ChatCase[]
  exfil?: ExfilSpec
}

export interface ToolCall {
  /** As the SDK names it (`mcp__inhouse__memory_search`) or a built-in (`WebFetch`). */
  name: string
  input: Record<string, unknown>
  result?: string
  isError?: boolean
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
}

export interface RunContext {
  caseId: string
  rep: number
  /** Unique invented canary of this case-repeat (exfiltration cases). */
  canary: string
}

/** One case-repeat on a target. Own object per case-repeat so a concurrent run never shares state. */
export interface Session {
  chat(prompt: string, opts?: { signal?: AbortSignal }): Promise<ChatResult>
  /** Ends the case-repeat: clears what the session seeded. */
  reset(): Promise<void>
}

export interface Target {
  readonly name: 'fake' | 'fixture' | 'product'
  /** The people keys mapped to this target's ids. */
  readonly people: People
  /** Tool families this target can serve (`shop`, `mail`, `routines`); a case needing another is not run. */
  readonly provides: ReadonlySet<string>
  /** False for a case this target has no way to serve (the fixture target holds only S5's runs). */
  canRun?(c: Case): boolean
  /** Starts a case-repeat: seeds its memory, plants exfiltration data. (The brief's seed(), reset() and chat(), split into
   *  a session per case-repeat so concurrent runs don't share a case counter.) */
  seed(memory: SeedFact[], run: RunContext, exfil?: ExfilSpec): Promise<Session>
  /** Server-reported spend so far in USD, when the target knows it (the product target); else the runner sums. */
  spentUsd?(): number
}

export interface CheckVerdict {
  checks: Record<string, boolean>
  pass: boolean
  runOk: boolean
  called: string[]
  toolSearches: number
}
