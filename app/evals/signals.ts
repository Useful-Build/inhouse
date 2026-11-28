// The signals that cancel an eval run, with their exit codes, for every runner (#711, #719): a Ctrl-C (SIGINT), a hangup
// (SIGHUP: a closed terminal or a dropped SSH session, whose default would end the run with no give-back, its lease, shop
// override or Slack left behind) and a job's stop (SIGTERM).
export const CANCEL_SIGNALS = [['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]] as const

/** What a runner's stop handlers need from the process: listen, say a line, exit. */
export interface SignalHost {
  on(signal: 'SIGINT' | 'SIGHUP' | 'SIGTERM', handler: () => void): void
  exit(code: number): void
  error(line: string): void
}

/**
 * The real process as a SignalHost. `on`, never `once`: a handler that unregisters itself on the first signal leaves a second
 * Ctrl-C to Node's default, which ends the runner with no give-back (#737 review). Each runner guards against a second run of
 * its own handler instead (a `stopping` flag).
 */
export const signalHost = (proc: Pick<NodeJS.Process, 'on' | 'exit'> = process): SignalHost => ({
  on: (signal, handler) => void proc.on(signal, handler),
  exit: (code) => proc.exit(code),
  error: (line) => console.error(line),
})
