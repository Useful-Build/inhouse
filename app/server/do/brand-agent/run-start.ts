// A turn's `RunStart` (protocol v2, p3-design 4.4) without its token, and the ids the BrandAgent makes. The start is
// stored on the turn (`turns.start_json`) so a placement retry mints a fresh token and sends the same start; the token
// joins it only in memory, on its way to the pool.
import { composeTurnPrompt } from '../../../shared/contract/runs.ts'
import type { RunStart } from '../../../shared/protocol/index.ts'

/**
 * The per-turn ceilings in micro-USD by API id (p3-design 9, item 22 E2). W3's catalog.ts carries the same table as
 * `TURN_CEILING_MICRO` (PR #145); this copy goes once that merges (the orchestrator's note in the PR body).
 */
export const TURN_CEILING_MICRO: Readonly<Record<string, number>> = {
  'claude-fable-5-2': 52_120_000,
  'claude-opus-5-5': 27_160_000,
  'claude-sonnet-5-5': 14_680_000,
  'claude-haiku-5-5': 5_320_000,
}

/**
 * The file caps every run carries (p3-design 8.5, in exact bytes). W3's `files-io/caps.ts` owns the one constant; this
 * copy goes once it lands (the orchestrator's note in the PR body).
 */
export const RUN_FILE_CAPS: RunStart['fileCaps'] = {
  maxFileBytes: 20_971_520,
  maxFilesPerTurn: 20,
  maxRestoreBytes: 104_857_600,
  allowedTypes: [
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/csv', 'text/plain', 'text/markdown', 'application/json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
}

/** A turn's attachment as stored: the input row's id, name and path (from `files.inputsOf`, never the client's names). */
export interface StoredAttachment { fileId: string; name: string; path: string }

export type StartWithoutToken = Omit<RunStart, 'runToken'>

export interface StartInput {
  turnId: string
  chatId: string
  sessionId: string
  expect: RunStart['expect']
  text: string
  quote: string | null
  attachments: readonly StoredAttachment[]
  model: string
  sideModel: string
  effort: RunStart['effort']
  maxTurns: number
  webFetchDomains: string[] | null
  systemPrompt: string
}

export function buildStart(i: StartInput): StartWithoutToken {
  const ceiling = TURN_CEILING_MICRO[i.model]
  if (ceiling === undefined) throw new Error(`no per-turn ceiling for ${i.model}`)
  return {
    runId: i.turnId,
    chatId: i.chatId,
    sessionId: i.sessionId,
    resume: i.expect !== null,
    prompt: composeTurnPrompt({ text: i.text, quote: i.quote ?? undefined, attachments: i.attachments }),
    model: i.model,
    sideModel: i.sideModel,
    systemPrompt: i.systemPrompt,
    attachments: i.attachments.map(a => a.path),
    expect: i.expect,
    effort: i.effort,
    maxTurns: i.maxTurns,
    maxBudgetUsd: ceiling / 1_000_000,
    webFetchDomains: i.webFetchDomains,
    fileCaps: RUN_FILE_CAPS,
  }
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** `r_` or `t_` and 128 random bits (p3-design 0). */
export const newId = (prefix: 'r_' | 't_'): string => prefix + base64url(crypto.getRandomValues(new Uint8Array(16)))

/**
 * A send's payload fingerprint, synchronous (the claim can't await, 4.2.1): FNV-1a 64 over the canonical JSON of the
 * fields a retried POST must repeat. Two different payloads collide with probability about 2^-64.
 */
export function payloadHash(v: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(v))
  let h = 0xcbf29ce484222325n
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n)
  return h.toString(16).padStart(16, '0')
}
