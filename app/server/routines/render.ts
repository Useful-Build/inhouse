// A slot's stored turn (p4-w2.md section 4, step 1, Opus F5): the text and every other field sent, rendered once when
// the slot is made, so a re-submit sends the same payload byte for byte whatever changed in the brand's settings since.
import type { OutputFormat } from '../../shared/protocol/index.ts'
import type { InternalSubmit } from '../do/brand-agent/ports.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import type { SubmitSettings } from './brand.ts'
import { endTaskId, slotChatId, slotClientKey } from './keys.ts'
import { outputFormatOf, routinePrompt } from './prompts.ts'
import type { NewSlot, RoutineRow } from './rows.ts'

/** `submit_json`: every field the submit sends besides the text, the chat and the key. */
export interface StoredSubmit extends SubmitSettings {
  priority: 'next'
  outputFormat?: OutputFormat
}

export const END_KIND = 'routine-end'

export async function renderSlot(
  r: RoutineRow, settings: SubmitSettings,
  s: Pick<NewSlot, 'slot_key' | 'kind' | 'local_date' | 'local_time' | 'tz' | 'due_at_ms' | 'deadline_ms' | 'state' | 'reason' | 'requested_by' | 'claimed_at_ms'>,
): Promise<NewSlot> {
  const outputFormat = outputFormatOf(r.kind)
  const stored: StoredSubmit = { ...settings, priority: 'next', ...(outputFormat ? { outputFormat } : {}) }
  return {
    ...s,
    routine_id: r.id,
    chat_id: await slotChatId(s.slot_key),
    client_key: await slotClientKey(s.slot_key),
    // The SDK gets our system prompt as a plain string, so nothing else tells the turn the date: the slot's due instant does.
    prompt_text: `${routinePrompt(r)}\n\nNow: ${new Date(s.due_at_ms).toISOString()}`,
    submit_json: JSON.stringify(stored),
    routine_rev: r.rev,
    creator_id: r.creator_id,
  }
}

/** The submit a stored slot sends: as `m_system`, with its end task (seam B). */
export function submitOf(slot: { slot_key: string; chat_id: string; client_key: string; prompt_text: string; submit_json: string }): InternalSubmit {
  const s = JSON.parse(slot.submit_json) as StoredSubmit
  return {
    chatId: slot.chat_id,
    input: { clientTurnKey: slot.client_key, text: slot.prompt_text, priority: s.priority, model: s.pickerId, attachments: [] },
    by: { kind: 'service', memberId: SYSTEM_MEMBER_ID },
    model: s.model, pickerId: s.pickerId, effort: s.effort, sideModel: s.sideModel, maxTurns: s.maxTurns, webFetchDomains: s.webFetchDomains,
    webSearch: s.webSearch === true,
    ...(s.outputFormat ? { outputFormat: s.outputFormat } : {}),
    onEnd: { kind: END_KIND, id: endTaskId(slot.slot_key) },
  }
}
