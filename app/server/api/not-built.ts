// P3 PR0's route stubs (p3-design section 13): every P3 route answers 503 `unavailable` with reason `not_built` until
// its owner replaces the stub in the owner's own file. No stub reads a body, a store or a binding.
import { apiError } from '../http.ts'
import type { Handler } from '../routes.ts'

/** The answer of a route whose handler isn't built yet. */
export const notBuilt: Handler = async () => apiError('unavailable', { reason: 'not_built' })
