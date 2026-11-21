// What a closed chat socket means (p3-design 4.10). Plain code, one table, tested against literal rows.
/** What the app does after a close: sign in again, clear the chat's privileged data, reload, wait and reconnect, or just reconnect. */
export type CloseOutcome =
  /** 4401: the session or the lease ended. Reconnect after a fresh sign-in (or show the signed-out screen when there is none). */
  | { kind: 'reauth' }
  /** 4403: a support grant ended. Say so and drop what the grant showed. */
  | { kind: 'grantEnded' }
  /** 4409: the server and this build disagree on the socket's version. Ask for a reload. */
  | { kind: 'reload' }
  /** 1012: the server restarts. Show "held" and reconnect. */
  | { kind: 'held' }
  /** Anything else (a lost connection): reconnect and attach from the last contiguous seq. */
  | { kind: 'reconnect' }

export const CLOSE_REAUTH = 4401
export const CLOSE_GRANT_ENDED = 4403
export const CLOSE_VERSION = 4409
export const CLOSE_RESTART = 1012

export function closeOutcome(code: number): CloseOutcome {
  switch (code) {
    case CLOSE_REAUTH: return { kind: 'reauth' }
    case CLOSE_GRANT_ENDED: return { kind: 'grantEnded' }
    case CLOSE_VERSION: return { kind: 'reload' }
    case CLOSE_RESTART: return { kind: 'held' }
    default: return { kind: 'reconnect' }
  }
}
