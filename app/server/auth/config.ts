// The product Worker's access config (p2-design section 2): the JSON var `INHOUSE_ACCESS`, parsed once per isolate.
// It holds no secrets (`aud` tags and client ids aren't secret). An invalid config makes every /api/* request 503
// `unavailable` and logs one line: the Worker fails closed, never open. This schema is what the Worker accepts at run
// time, test build included (`http://*.localhost` origins); what a deployable config must also meet (https only, an
// Access team domain, no workers.dev or preview hosts) is scripts/check-product-config.mjs.
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

export const AccessAppSchema = z.object({
  /** `brand` is the brand's app (people, `smoke`, `monitor`); `inhouse` is the Inhouse team's app. */
  name: z.enum(['brand', 'inhouse']),
  /** Where the app is served; the request's host must equal this origin's host, and `Origin` must equal it exactly. */
  origin: OriginSchema,
  /** The JWT's `aud` must contain this. */
  aud: AudSchema,
})
export type AccessApp = z.infer<typeof AccessAppSchema>

export const AccessConfigSchema = z.object({
  /** The JWT issuer and the JWKS's home (`<teamDomain>/cdn-cgi/access/certs`); a bare https origin. */
  teamDomain: OriginSchema.refine(s => s.startsWith('https://'), { message: 'teamDomain must be https' }),
  /** Exactly one `brand` and one `inhouse` app, on different hosts with different `aud` tags. */
  apps: z.array(AccessAppSchema).length(2)
    .refine(a => new Set(a.map(x => x.name)).size === 2, { message: 'apps must be one brand and one inhouse' })
    .refine(a => new URL(a[0].origin).host !== new URL(a[1].origin).host, { message: 'apps share a host' })
    .refine(a => a[0].aud !== a[1].aud, { message: 'apps share an aud' }),
  /** Service token `common_name` (its client id, `<id>.access`) → which service it is. Unknown ones are 401. */
  serviceTokens: z.record(z.string().min(1), z.enum(['monitor', 'smoke'])),
})
export type AccessConfig = z.infer<typeof AccessConfigSchema>
