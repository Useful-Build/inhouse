// Whether a link to a tool names one (P5 W3). The sign-in's return opens `/tools/<tool>` before the tools have been read, so a
// key the list doesn't hold yet isn't unknown until the read has answered: until then the page waits.
import type { ToolsData } from '../agent/types'

/** A tool's or channel's name, or undefined for a key that is neither (a stale or typed link). */
export const toolName = (t: ToolsData, k: string): string | undefined => t.channels.find(c => c.key === k)?.name ?? (Object.hasOwn(t.details, k) ? t.details[k].name : undefined)

export type ToolRoute = 'known' | 'wait' | 'unknown' | 'failed'
/**
 * `status` is the tools resource's: `loading` until the first read answers. A read that failed says nothing about the key, so
 * the link stays and the page shows the failure (`failed`); only a read that worked can call a key `unknown`.
 */
export const toolRoute = (t: ToolsData, k: string, status: 'loading' | 'ready' | 'error'): ToolRoute =>
  toolName(t, k) !== undefined ? 'known' : status === 'loading' ? 'wait' : status === 'error' ? 'failed' : 'unknown'
