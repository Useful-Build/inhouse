// Whether a link to a tool names one (P5 W3). The sign-in's return opens `/tools/<tool>` before the tools have been read, so a
// key the list doesn't hold yet isn't unknown until the read has answered: until then the page waits.
import type { ToolsData } from '../agent/types'

/** A tool's or channel's name, or undefined for a key that is neither (a stale or typed link). */
export const toolName = (t: ToolsData, k: string): string | undefined => t.channels.find(c => c.key === k)?.name ?? (Object.hasOwn(t.details, k) ? t.details[k].name : undefined)

export type ToolRoute = 'known' | 'wait' | 'unknown'
/** `status` is the tools resource's: `loading` until the first read answers (an error answers too). */
export const toolRoute = (t: ToolsData, k: string, status: 'loading' | 'ready' | 'error'): ToolRoute =>
  toolName(t, k) !== undefined ? 'known' : status === 'loading' ? 'wait' : 'unknown'
