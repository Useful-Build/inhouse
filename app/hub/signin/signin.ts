// The SignIn Durable Object: one per connector account (wrangler.hub.jsonc declares the class and its SQLite
// migration). Hub PR0 ships it empty so the config, the types and both bundles have a real class to bind. H0 replaces
// this file (docs/plans/2026-11-19-p4-watch.md, H0).
import { DurableObject } from 'cloudflare:workers'

export class SignIn extends DurableObject<Env> {}
