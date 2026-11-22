// The root's last catch (P8a P-auth): an uncaught exception or an unhandled rejection is logged by its name and code
// only, then the root exits 1 as Node would. Node's own handler would print the error's message and stack to the
// container log, and a message can quote chat, tool or file content.
import { safeError } from '../safe-error.ts'

type Proc = { on(event: 'uncaughtException' | 'unhandledRejection', fn: (e: unknown) => void): unknown; exit(code: number): void }

export function logCrashes(proc: Proc, log: (entry: Record<string, unknown>) => void): void {
  proc.on('uncaughtException', (e) => {
    log({ type: 'root_uncaught_exception', error: safeError(e) })
    proc.exit(1)
  })
  proc.on('unhandledRejection', (e) => {
    log({ type: 'root_unhandled_rejection', error: safeError(e) })
    proc.exit(1)
  })
}
