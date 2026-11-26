// A turn's `RunStart` (protocol v2, p3-design 4.4) without its token, and the ids the BrandAgent makes. The start is
// stored on the turn (`turns.start_json`) so a placement retry mints a fresh token and sends the same start; the token
// joins it only in memory, on its way to the pool.
import { composeTurnPrompt } from '../../../shared/contract/runs.ts'
import { TURN_CEILING_MICRO } from '../../model/catalog.ts'
import { FILE_CAPS } from '../../files-io/caps.ts'
import { canonicalJson, type RunStart } from '../../../shared/protocol/index.ts'

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
  /** null only from a turn stored before P8a S: sent as `[]`, no host. */
  webFetchDomains: string[] | null
  /** Web search (P8a S): sent as `webSearch: true` only when true, and left out otherwise. */
  webSearch?: boolean
  systemPrompt: string
  /** Structured output (PR 5, ask C): the run answers a JSON value matching it. Absent on a turn without one. */
  outputFormat?: RunStart['outputFormat']
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
    // Per query() call, never the resumed session's earlier spend (SDK 0.3.328 sdk.d.ts:6252; agent-sdk/cost-tracking, read 2026-11-21).
    maxBudgetUsd: ceiling / 1_000_000,
    // Never null (the runner's "any public host"): a list, empty for none (P8a S).
    webFetchDomains: i.webFetchDomains ?? [],
    // The key only when on (like outputFormat): RunStart is a strict object, so a runner on an image from before P8a
    // refuses a start that carries it; off is its absence.
    ...(i.webSearch === true ? { webSearch: true } : {}),
    fileCaps: FILE_CAPS,
    ...(i.outputFormat === undefined ? {} : { outputFormat: i.outputFormat }),
  }
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** `r_` or `t_` and 128 random bits (p3-design 0). */
export const newId = (prefix: 'r_' | 't_'): string => prefix + base64url(crypto.getRandomValues(new Uint8Array(16)))

/**
 * The fields of a send the payload hash covers (design 4.3; A2, 2026-11-20): the caller's input as sent. Not
 * `clientTurnKey` (the key itself), the principal, or anything the server resolves or mints (route 29's model id,
 * effort and settings, timestamps, ids), so a byte-for-byte re-submit after a settings change is still a dedupe.
 * `effort`, `outputFormat` and `onEnd` are hashed when the caller sends them: only `TaskContext.runs.submit` does (its
 * caller resolved the effort itself, route 29's settings function); route 29 sends none of the three.
 */
export const PAYLOAD_FIELDS = ['text', 'quote', 'attachments (ids, in order)', 'model', 'effort', 'priority', 'outputFormat', 'onEnd'] as const

export interface SubmitPayload {
  text: string
  quote?: string
  attachments: readonly { fileId: string }[]
  model: string
  effort?: string
  priority: string
  outputFormat?: unknown
  onEnd?: unknown
}

/** JSON with every object's keys sorted and `undefined` dropped: the protocol's one canonical form (Stage 1, N14). */
export { canonicalJson }

/** `payload_hash`: the SHA-256 (hex) of the canonical JSON of `PAYLOAD_FIELDS` as the caller sent them. */
export async function submitPayloadHash(input: SubmitPayload): Promise<string> {
  const payload = {
    text: input.text, quote: input.quote, attachments: input.attachments.map(a => a.fileId), model: input.model,
    effort: input.effort, priority: input.priority, outputFormat: input.outputFormat, onEnd: input.onEnd,
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(payload)))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
