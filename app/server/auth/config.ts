// The product Worker's access config (p2-design section 2): the JSON var `INHOUSE_ACCESS`, parsed once per isolate.
// It holds no secrets (`aud` tags and client ids aren't secret). An invalid config makes every /api/* request 503
// `unavailable` and logs one line: the Worker fails closed, never open. This schema is what the Worker accepts at run
// time, test build included (`http://*.localhost` origins); what a deployable config must also meet (https only, an
// Access team domain, no workers.dev or preview hosts) is scripts/check-product-config.mjs.
// `safeParse` never throws, whatever the input: every cross-field check runs in one `superRefine` that returns early
// when the shape is already wrong (zod 4 runs later refinements after an earlier one failed).
import { z } from 'zod'

/** An origin with nothing after it: `https://host[:port]`, as `new URL(x).origin` prints it. */
const OriginSchema = z.string().refine(s => {
  try {
    const u = new URL(s)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === s
  } catch {
    return false
  }
}, { message: 'not a bare http(s) origin' })

/** An Access application's audience tag: 64 lower-case hex. */
const AudSchema = z.string().regex(/^[0-9a-f]{64}$/, { message: 'aud must be 64 lower-case hex' })

/** Unknown keys fail closed. */
export const AccessAppSchema = z.strictObject({
  /** `brand` is the brand's app (people, `smoke`, `monitor`); `inhouse` is the Inhouse team's app. */
  name: z.enum(['brand', 'inhouse']),
  /** Where the app is served; the request's host must equal this origin's host, and `Origin` must equal it exactly. */
  origin: OriginSchema,
  /** The JWT's `aud` must contain this. */
  aud: AudSchema,
})
export type AccessApp = z.infer<typeof AccessAppSchema>

/** Unknown keys fail closed. */
export const AccessConfigSchema = z.strictObject({
  /** The JWT issuer and the JWKS's home (`<teamDomain>/cdn-cgi/access/certs`); a bare https origin. */
  teamDomain: OriginSchema.refine(s => s.startsWith('https://'), { message: 'teamDomain must be https' }),
  /** Exactly one `brand` and one `inhouse` app, on different hostnames with different `aud` tags. */
  apps: z.array(AccessAppSchema),
  /**
   * Service token `common_name` (its client id, `<id>.access`) → which service it is; unknown ones are 401. A `Map`,
   * so a client id such as `toString` or `__proto__` can never reach the prototype.
   */
  serviceTokens: z.record(z.string().min(1), z.enum(['monitor', 'smoke'])).transform(o => new Map(Object.entries(o))),
}).superRefine((c, ctx) => {
  if (!Array.isArray(c.apps) || c.apps.length !== 2) {
    ctx.addIssue({ code: 'custom', path: ['apps'], message: 'apps must be exactly one brand and one inhouse' })
    return
  }
  const [a, b] = c.apps
  // Field checks may have failed already (zod still runs this): read the origins without trusting them.
  // Hostname, not host: Access's CF_Authorization cookie is scoped per hostname, so two apps that differ only by port
  // would share it.
  const host = (origin: unknown) => {
    try {
      return new URL(String(origin)).hostname
    } catch {
      return null
    }
  }
  if (a?.name === b?.name) ctx.addIssue({ code: 'custom', path: ['apps'], message: 'apps must be one brand and one inhouse' })
  const [ha, hb] = [host(a?.origin), host(b?.origin)]
  if (ha !== null && ha === hb) ctx.addIssue({ code: 'custom', path: ['apps'], message: 'apps share a hostname' })
  if (a?.aud === b?.aud) ctx.addIssue({ code: 'custom', path: ['apps'], message: 'apps share an aud' })
})
export type AccessConfig = z.infer<typeof AccessConfigSchema>
