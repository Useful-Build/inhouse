// Pause and resume over HTTP (P3, p3-design section 3): route 35 reads, 36 pauses (Admin, or Inhouse for an emergency), 37
// resumes. Plain code (the entry's size budget, schemas.ts).
import type { PauseState } from '../types'
import type { Transport } from './transport'

export const readPause = (http: Transport): Promise<PauseState> => http.call({ method: 'GET', path: '/api/pause', schema: 'pause' })
// Routes 36 and 37 read a JSON body, `{}` and nothing else (server/api/pause.ts `NoBody`): a request with none is 400.
export const setPause = (http: Transport, paused: boolean): Promise<PauseState> =>
  http.call({ method: 'POST', path: paused ? '/api/pause' : '/api/resume', schema: 'pause', json: {} })
