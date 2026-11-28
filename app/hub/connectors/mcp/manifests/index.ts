// The known-server manifests (Stage 1 M4-R1, N39): one line per server, matched by its exact endpoint. Empty until a
// package adds one (M4-D adds the fixture's, in the test bundle only). Read by detect and prepare to pre-fill a binding's
// settings; the record's settings are the truth after that (connections/record.ts).
import type { McpManifest } from './types'

export const MANIFESTS: readonly McpManifest[] = []

/** The manifest for exactly this endpoint, or null. Never an origin, prefix or normalised-away match. */
export function manifestFor(endpoint: string, manifests: readonly McpManifest[] = MANIFESTS): McpManifest | null {
  let href: string
  try {
    href = new URL(endpoint).href
  } catch {
    return null
  }
  return manifests.find(m => m.endpoint === href) ?? null
}
