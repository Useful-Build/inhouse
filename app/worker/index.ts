// Static assets are served before the Worker runs, except /api/*: `assets.run_worker_first` sends every request to
// /api/*, navigations included, to the Worker.
import headersFile from '../public/_headers?raw'
import { parseHeaders, respond } from '../shared/security-headers.ts'
import { clientError } from './client-error.ts'

/** The `/*` block of public/_headers. `_headers` doesn't apply to Worker responses, so the Worker sets the same ones. */
const SECURITY_HEADERS = parseHeaders(headersFile)

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/client-error') return clientError(request, SECURITY_HEADERS)
    return respond(SECURITY_HEADERS, 404)
  },
} satisfies ExportedHandler<Env>
