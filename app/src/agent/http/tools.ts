// The Tools page over HTTP (P5 W3, p5-w3.md): route C reads the tools, D pauses or resumes one, E disconnects an OAuth
// one, and W1's route A starts a connect. The client speaks connector keys (`slack`); the server maps them to the hub's
// account ids, so no account id is built here. Plain code, no zod (the entry's size budget, schemas.ts): the transport
// parses each answer with the lazily loaded schemas, and a body is built from them by the caller's `Contract`.
import type { ToolsData } from '../../../shared/contract/tools'
import type { Contract, Transport } from './transport'

const path = (key: string, tail: string): string => `/api/tools/${encodeURIComponent(key)}/${tail}`

/** Route C. */
export const readTools = (http: Transport): Promise<ToolsData> => http.call({ method: 'GET', path: '/api/tools', schema: 'tools' })

/** Route D: sets the tool's pause (a boolean, so a repeat changes nothing). Answers the state after. */
export const putToolPaused = (http: Transport, k: Contract, key: string, paused: boolean): Promise<{ paused: boolean }> =>
  http.call({ method: 'PUT', path: path(key, 'paused'), schema: 'toolPaused', json: k.BODIES.toolPaused.parse({ paused }) })

/** Route E. `revoked: false`: the access wasn't revoked at the tool's end, so the team removes the app there too. */
export const postToolDisconnect = (http: Transport, key: string): Promise<{ revoked: boolean }> =>
  http.call({ method: 'POST', path: path(key, 'disconnect'), schema: 'toolDisconnect', json: {} })

/** W1's route A: where the browser goes to sign in. The caller navigates there. */
export const postToolConnect = (http: Transport, key: string): Promise<{ authorizeUrl: string }> =>
  http.call({ method: 'POST', path: `/api/connect/${encodeURIComponent(key)}/start`, schema: 'toolConnect', json: {} })
