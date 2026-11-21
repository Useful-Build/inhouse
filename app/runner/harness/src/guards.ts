// The harness's two guards, kept free of Workers imports so the runner's tests can check them
// (app/runner/test/run/harness-guards.test.ts).

/**
 * The var only the harness's own `npm run dev` sets (`wrangler dev --var`). A deployed copy doesn't have it and refuses
 * every request, so a stray `wrangler deploy` can't put the scripted model on the internet.
 */
export const LOCAL_ONLY_VAR = 'HARNESS_LOCAL_ONLY'

export function localOnlyRefusal(env: object): Response | null {
  if ((env as Record<string, unknown>)[LOCAL_ONLY_VAR] === '1') return null
  return new Response(`the runner harness runs only under \`npm run dev\` (wrangler dev with ${LOCAL_ONLY_VAR}=1)`, { status: 403 })
}

/** Headers the scripted model must never see: the run token and any model credential. */
const NOT_FOR_THE_MODEL = ['x-inhouse-run-token', 'x-api-key', 'authorization']

/**
 * The egress's `/model/*` call as the scripted model gets it: the path under `/model`, without the run token or any
 * credential, as the real egress strips them before it adds its own key. That the real egress (W3) strips them is W3's
 * to test; this only keeps the harness from modelling a leak.
 */
export function forScriptedModel(request: Request, sub: string): Request {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  for (const h of NOT_FOR_THE_MODEL) headers.delete(h)
  // `duplex` for Node (the tests), where a streamed body needs it; workerd ignores it.
  return new Request(new URL(sub + url.search, url), { method: request.method, headers, body: request.body, duplex: 'half' } as RequestInit)
}
