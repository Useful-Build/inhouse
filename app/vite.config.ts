import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { cloudflare } from "@cloudflare/vite-plugin";
import { restoreRedirect, snapshotRedirect } from './build-support/demo-deploy-redirect.ts'
import type { RedirectSnapshot } from './build-support/demo-deploy-redirect.ts'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const sampleData = fileURLToPath(new URL('./src/agent/sample-data', import.meta.url))
/** Sample files only the demo serves (the Library's files, the people's photos), at the same URLs as public/. */
const publicDemo = fileURLToPath(new URL('./public-demo', import.meta.url))
/** `vite build --mode product` (npm run build:product): the product build. Every other mode is the demo. */
const PRODUCT = 'product'
/** The product build's own output folder, so `npm run build` keeps writing the demo to dist/. */
const PRODUCT_OUT_DIR = 'dist-product'
/** The client entry `src/agent/index.ts` imports as `@client`, picked by mode (tsconfig.app.json and vitest.config.ts name the demo one). */
const clientEntry = (mode: string) =>
  fileURLToPath(new URL(mode === PRODUCT ? './src/agent/client.product.ts' : './src/agent/client.demo.ts', import.meta.url))

const walkFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walkFiles(join(dir, d.name)) : [join(dir, d.name)]))

/**
 * Hidden client source maps are never served: after the client build they move out of the assets directory to
 * sourcemaps/ beside it in the build's own output (dist/sourcemaps/, emptied at build start so stale maps don't pile
 * up; the deploy pipeline keeps it per SHA as a CI artifact), and an .assetsignore in the assets root stops Wrangler
 * uploading any .map left behind. https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets
 */
const mapsDirFor = (assetsDir: string) => resolve(assetsDir, '..', 'sourcemaps')

function keepSourceMapsOut(): Plugin {
  return {
    name: 'inhouse:keep-source-maps-out',
    apply: 'build',
    applyToEnvironment: env => env.name === 'client',
    buildStart() {
      const { root, build } = this.environment.config
      rmSync(mapsDirFor(resolve(root, build.outDir)), { recursive: true, force: true })
    },
    writeBundle(options) {
      const assetsDir = resolve(options.dir ?? 'dist/client')
      const mapsDir = mapsDirFor(assetsDir)
      for (const file of walkFiles(assetsDir).filter(f => f.endsWith('.map'))) {
        const to = join(mapsDir, relative(assetsDir, file))
        mkdirSync(dirname(to), { recursive: true })
        renameSync(file, to)
      }
      writeFileSync(join(assetsDir, '.assetsignore'), '*.map\n')
    },
  }
}

/**
 * Every module id in the client build's graph, relative to app/ with forward slashes, written beside the client output
 * (dist/client-modules.json, dist-product/client-modules.json), never into it, so it isn't served.
 * scripts/check-product-build.mjs reads it: a string scan alone can't prove a tree-shaken or renamed import is gone.
 */
function writeModuleList(): Plugin {
  return {
    name: 'inhouse:module-list',
    apply: 'build',
    applyToEnvironment: env => env.name === 'client',
    writeBundle(options) {
      const assetsDir = resolve(options.dir ?? 'dist/client')
      const ids = [...this.getModuleIds()].map(id => {
        const file = id.startsWith('\0') ? id : relative(appRoot, id)
        return file.split(sep).join('/')
      }).sort()
      writeFileSync(resolve(assetsDir, '..', 'client-modules.json'), JSON.stringify(ids, null, 2) + '\n')
    },
  }
}

const CONTENT_TYPES: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

/**
 * The demo-only public files (public-demo/), outside product mode only: the dev server serves them, and the client build
 * copies them byte for byte to the same paths in its output, so `vite preview` and a deploy serve them as before.
 * Vite has one publicDir (public/, copied in every mode), so this is the second one.
 */
function demoPublicFiles(): Plugin[] {
  const serve: Plugin = {
    name: 'inhouse:demo-public-files:serve',
    apply: 'serve',
    configureServer(server) {
      // Added before Vite's own middlewares, so these paths never reach the SPA fallback.
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        let path: string
        try { path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname) } catch { return next() }
        const file = resolve(publicDemo, '.' + path)
        if (!file.startsWith(publicDemo + sep) || !existsSync(file) || !statSync(file).isFile()) return next()
        res.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream')
        res.setHeader('Content-Length', statSync(file).size)
        if (req.method === 'HEAD') return res.end()
        createReadStream(file).pipe(res)
      })
    },
  }
  const copy: Plugin = {
    name: 'inhouse:demo-public-files:copy',
    apply: 'build',
    applyToEnvironment: env => env.name === 'client',
    generateBundle() {
      for (const file of walkFiles(publicDemo)) {
        this.emitFile({ type: 'asset', fileName: relative(publicDemo, file).split(sep).join('/'), source: readFileSync(file) })
      }
    },
  }
  return [serve, copy]
}

/**
 * The Cloudflare plugin writes one redirect per project, .wrangler/deploy/config.json, pointing `vite preview` and
 * `wrangler deploy` at the last build's Worker config. A product build would point it at dist-product/, so this puts
 * back what was there (the demo build's, or nothing) however the build ends: after buildApp, and on process exit for a
 * failed or thrown build. It restores only a pointer into dist-product/, so a concurrent demo build's is never
 * clobbered (build-support/demo-deploy-redirect.ts). The product build is served with
 * `wrangler dev -c dist-product/inhouse_app/wrangler.json` instead (playwright.config.ts, the product project).
 */
function keepDemoDeployRedirect(): Plugin {
  const redirect = resolve(appRoot, '.wrangler/deploy/config.json')
  let snapshot: RedirectSnapshot | null = null
  const restore = () => { if (snapshot) restoreRedirect(snapshot, PRODUCT_OUT_DIR) }
  return {
    name: 'inhouse:keep-demo-deploy-redirect',
    apply: 'build',
    config() {
      snapshot = snapshotRedirect(redirect)
      process.once('exit', restore)
    },
    // After the Cloudflare plugin's own post buildApp (which comes first in the plugin list) has written it.
    buildApp: {
      order: 'post',
      async handler() {
        restore()
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const product = mode === PRODUCT
  return {
    plugins: [
      react(), tailwindcss(), cloudflare(), keepSourceMapsOut(), writeModuleList(),
      ...(product ? [keepDemoDeployRedirect()] : demoPublicFiles()),
    ],
    resolve: {
      alias: { '@client': clientEntry(mode), '@sample': sampleData, '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // The Cloudflare plugin puts each environment under build.outDir: dist-product/client and dist-product/inhouse_app.
    ...(product ? { build: { outDir: PRODUCT_OUT_DIR } } : {}),
    // The commit the build came from, sent with every client error report (src/report-error.ts).
    define: { __RELEASE_SHA__: JSON.stringify(process.env.RELEASE_SHA || 'dev') },
    environments: { client: { build: { sourcemap: 'hidden' } } },
  }
})
