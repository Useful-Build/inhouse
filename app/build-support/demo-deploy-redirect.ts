// The Cloudflare plugin writes one redirect per project, .wrangler/deploy/config.json ({"configPath": "<Worker config>"}),
// pointing `vite preview` and `wrangler deploy` at the last build's Worker config. The product build must leave it on
// the demo build however it ends, and never undo a pointer a concurrent demo build wrote. vite.config.ts uses these;
// demo-deploy-redirect.test.ts tests them on a temp folder.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

/** What the redirect held when the product build started (null: no file), read once at config() time. */
export type RedirectSnapshot = { file: string; before: string | null }

/** True when the redirect's content points at a Worker config inside `outDir` (a folder name such as dist-product). */
export const pointsInto = (content: string, outDir: string): boolean => {
  let configPath: unknown
  try { configPath = (JSON.parse(content) as { configPath?: unknown }).configPath } catch { return false }
  return typeof configPath === 'string' && configPath.split(/[\\/]/).includes(outDir)
}

export const snapshotRedirect = (file: string): RedirectSnapshot =>
  ({ file, before: existsSync(file) ? readFileSync(file, 'utf8') : null })

/**
 * Puts the redirect back to what it held before, only if it now points into `productOutDir`: that content can only
 * come from a product build, so a pointer a concurrent demo build wrote (or an untouched one) is left alone. If the
 * snapshot itself pointed into the product (a run that died before restoring), the file is removed instead, so
 * `vite preview` fails loud rather than serving the product. Returns what it did.
 */
export const restoreRedirect = ({ file, before }: RedirectSnapshot, productOutDir: string): 'restored' | 'removed' | 'left' => {
  if (!existsSync(file) || !pointsInto(readFileSync(file, 'utf8'), productOutDir)) return 'left'
  if (before === null || pointsInto(before, productOutDir)) {
    rmSync(file, { force: true })
    return 'removed'
  }
  writeFileSync(file, before)
  return 'restored'
}
