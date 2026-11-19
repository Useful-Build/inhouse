// Client error reports to the Worker (`POST /api/client-error`, worker/index.ts), which logs them to Workers Logs.
import type { ReportKind } from '../worker/scrub.ts'
import { scrubReport } from '../worker/scrub.ts'
import { demoEnabled } from './shell/demo'

/** The commit this bundle was built from (vite.config.ts `define`, from RELEASE_SHA). */
declare const __RELEASE_SHA__: string

const ENDPOINT = '/api/client-error'
const MAX_PER_LOAD = 5
const seen = new Set<string>()
let sent = 0

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string') return new Error(value)
  try { return new Error(JSON.stringify(value)) } catch { return new Error(String(value)) }
}

/** Sends one scrubbed report. The same error is sent once, and at most MAX_PER_LOAD reports per page load. */
export function reportError(kind: ReportKind, value: unknown): void {
  const error = asError(value)
  // Keyed without the kind, so an error that reaches two hooks is still sent once.
  const key = `${error.message}\n${error.stack?.split('\n', 3).join('\n') ?? ''}`
  if (seen.has(key) || sent >= MAX_PER_LOAD) return
  seen.add(key)
  sent++
  const body = JSON.stringify(scrubReport({
    message: error.message, stack: error.stack ?? '', url: location.href, release: __RELEASE_SHA__, kind,
  }))
  // A string body goes as text/plain, which sendBeacon always allows; the Worker parses it as JSON.
  if (navigator.sendBeacon?.(ENDPOINT, body)) return
  fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } })
    .catch(e => console.warn('Inhouse: could not send the error report.', e))
}

/** The `window` error and unhandled rejection hooks. Call once, before the first render. */
export function installErrorReporting(): void {
  window.addEventListener('error', e => {
    // A ResizeObserver loop notice is the browser's, not a bug, and carries no error.
    if (!e.error && /ResizeObserver loop/.test(e.message)) return
    reportError('error', e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', e => reportError('rejection', e.reason))
  // Demo switch for the E2E specs: `?demo&crash=rejection` leaves one promise rejection unhandled.
  if (demoCrash() === 'rejection') {
    void Promise.reject(new Error('Demo rejection for qa.person@example.com with token=demo0123456789abcdefghijklmn'))
  }
}

/** `?demo&crash=screen` (a screen throws while rendering) or `?demo&crash=rejection`; null otherwise. */
export function demoCrash(): 'screen' | 'rejection' | null {
  if (!demoEnabled()) return null
  const v = new URLSearchParams(location.search).get('crash')
  return v === 'screen' || v === 'rejection' ? v : null
}
