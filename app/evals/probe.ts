// The eval host's lock probe (Wasim's E-5 second lock), no spend: run by inhouse-ops' eval-run before the paid step and by
// eval-deploy after the deploy.
//   node evals/probe.ts
// Env: INHOUSE_EVAL_ORIGIN, INHOUSE_EVAL_AUD, INHOUSE_EVAL_ISSUER_JWK_FILE, INHOUSE_EVAL_ACCESS_CLIENT_ID and _SECRET.
// 1. An anonymous GET /api/me is refused at the edge (Access), never answered by the Worker itself (its own 401 is JSON).
// 2. GET /api/me with the service token and an eval person's test-issuer JWT answers 200 with evalBrand: true: Access let
//    the call through and the eval build still signed the person in. A 401 from the Worker here means Access replaced the
//    test issuer's Cf-Access-Jwt-Assertion.
// Known limits (#277 review F2, F3), bounded because the test issuer stays the first lock (an Access login by a person gives
// a team-domain token the eval build doesn't trust); to tighten after the first real run:
//  - the probe sees the app from outside, so an extra Allow policy beside the Service Auth one still passes (a Bypass
//    policy doesn't: the anonymous call then reaches the Worker);
//  - any 401 or 403 that isn't the Worker's JSON counts as the edge's refusal (another zone rule would too), though the
//    signed half then fails the same way, so the probe can't pass without Access letting the token in.
// Reads only /api/me: no chat, no model, no write. Prints no token or secret. Exit 0 the lock holds and lets the harness
// in, 1 it doesn't, 2 usage.
import { pathToFileURL } from 'node:url'
import { accessHeaders, EVAL_ORIGIN_VAR, ProductTargetRefusal, testIssuerSignIn } from './targets/product.ts'

type Fetch = typeof fetch

/** True when the answer is the Worker's own refusal (its JSON error body), not the edge's. */
function workerAnswered(res: Response, text: string): boolean {
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) return false
  try { return typeof JSON.parse(text)?.error?.code === 'string' } catch { return false }
}

/** Every reason the lock doesn't hold or doesn't let the harness in (empty: it does). */
export async function probeEvalLock(env: Record<string, string | undefined>, doFetch: Fetch = fetch): Promise<string[]> {
  const origin = env[EVAL_ORIGIN_VAR]
  if (!origin) throw new ProductTargetRefusal(`refusing: ${EVAL_ORIGIN_VAR} is not set`)
  const edge = accessHeaders(env)
  const signIn = testIssuerSignIn(env)
  const f: string[] = []
  const timeout = () => AbortSignal.timeout(20_000)

  const anon = await doFetch(`${origin}/api/me`, { redirect: 'manual', signal: timeout() })
  const anonText = await anon.text()
  const location = anon.headers.get('location') ?? ''
  const atEdge = ((anon.status === 302 || anon.status === 303) && location.includes('/cdn-cgi/access/')) ||
    ((anon.status === 401 || anon.status === 403) && !workerAnswered(anon, anonText))
  if (workerAnswered(anon, anonText)) f.push(`an anonymous GET /api/me reached the Worker (${anon.status}): nothing refuses it at the edge`)
  else if (!atEdge) f.push(`an anonymous GET /api/me answered ${anon.status}, not the Access edge's refusal`)

  const person = await signIn('current')
  const res = await doFetch(`${origin}/api/me`, { redirect: 'manual', headers: { ...person, ...edge }, signal: timeout() })
  const text = await res.text()
  if (res.status === 200) {
    let me: { evalBrand?: unknown } | null = null
    try { me = JSON.parse(text) } catch { /* not JSON */ }
    if (me?.evalBrand !== true) f.push('GET /api/me with the service token answered 200 without evalBrand: true: not the eval brand')
  } else if (workerAnswered(res, text)) {
    f.push(`GET /api/me with the service token reached the Worker, which refused the person (${res.status}): Access likely replaced the test issuer's Cf-Access-Jwt-Assertion`)
  } else {
    f.push(`GET /api/me with the service token was refused at the edge (${res.status}): Access didn't take the service token`)
  }
  return f
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probeEvalLock(process.env).then((f) => {
    if (f.length) {
      console.error(`probe: the eval host's lock isn't right:\n${f.map((x) => `  - ${x}`).join('\n')}`)
      process.exit(1)
    }
    console.log('probe: Access refuses an anonymous call, and lets the service token and an eval person in')
  }, (err: unknown) => {
    console.error(`probe: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(err instanceof ProductTargetRefusal ? 2 : 1)
  })
}
