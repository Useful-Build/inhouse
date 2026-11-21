import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

import { cloudflare } from "@cloudflare/vite-plugin";
import { restoreOnAnyEnd, restoreRedirect, snapshotRedirect } from './build-support/demo-deploy-redirect.ts'
import type { RedirectSnapshot } from './build-support/demo-deploy-redirect.ts'

const appRoot = fileURLToPath(new URL('.', import.meta.url))
const sampleData = fileURLToPath(new URL('./src/agent/sample-data', import.meta.url))
/** Sample files only the demo serves (the Library's files, the people's photos), at the same URLs as public/. */
const publicDemo = fileURLToPath(new URL('./public-demo', import.meta.url))
/** `vite build --mode product` (npm run build:product): the product build. Every other mode is the demo, but one: */
const PRODUCT = 'product'
/**
 * `vite build --mode product-test` (npm run build:product-test): the TEST BUILD (P2, p2-design section 10). The product
 * build with the test issuer compiled in (`__INHOUSE_TEST_BUILD__`) and wrangler.test.jsonc's local config, served by
 * `wrangler dev` for the `api` and `real` Playwright projects. Never deployed.
 */
const PRODUCT_TEST = 'product-test'
/**
 * `vite build --mode product-eval` (npm run build:product-eval): the EVAL BUILD (p3-eval-observability rev 2, rec 1).
 * The test build's sign-in (the test issuer) with the real model (the egress always takes the gateway,
 * `__INHOUSE_EVAL_BUILD__`), no scripted model, and the eval trace (`@eval-trace`). Deployed only to the sandbox, from
 * main, by the ops repo (`check-product-config.mjs --sandbox --eval`); check-product-build.mjs proves its module and
 * canary are in no other build.
 */
const PRODUCT_EVAL = 'product-eval'
/** The product builds' own output folders, so `npm run build` keeps writing the demo to dist/. */
const PRODUCT_OUT_DIR = 'dist-product'
const PRODUCT_TEST_OUT_DIR = 'dist-product-test'
const PRODUCT_EVAL_OUT_DIR = 'dist-product-eval'
/** The Worker config each product mode builds `server/index.ts` from; the demo builds worker/ from wrangler.jsonc. */
const PRODUCT_CONFIG: Record<string, string> = { [PRODUCT]: 'wrangler.product.jsonc', [PRODUCT_TEST]: 'wrangler.test.jsonc', [PRODUCT_EVAL]: 'wrangler.eval.jsonc' }
/** Every product mode's output folder: keepDemoDeployRedirect restores a pointer into any of them (build-support/vite-config.test.ts). */
export const PRODUCT_OUT: Record<string, string> = { [PRODUCT]: PRODUCT_OUT_DIR, [PRODUCT_TEST]: PRODUCT_TEST_OUT_DIR, [PRODUCT_EVAL]: PRODUCT_EVAL_OUT_DIR }
/** The client entry `src/agent/index.ts` imports as `@client`, picked by mode (tsconfig.app.json and vitest.config.ts name the demo one). */
const clientEntry = (product: boolean) =>
  fileURLToPath(new URL(product ? './src/agent/client.product.ts' : './src/agent/client.demo.ts', import.meta.url))

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

/**
 * The same for the product Worker (server/), product modes only: dist-product/server-modules.json, beside the Worker's
 * folder, never in it, so `wrangler deploy` doesn't upload it. check-product-build.mjs's server bundle scan reads it.
 */
function writeServerModuleList(): Plugin {
  return {
    name: 'inhouse:server-module-list',
    apply: 'build',
    applyToEnvironment: env => env.name !== 'client',
    writeBundle(options) {
      if (!options.dir) throw new Error('writeServerModuleList: the Worker build has no output folder.')
      const ids = [...this.getModuleIds()].map(id => {
        const file = id.startsWith('\0') ? id : relative(appRoot, id)
        return file.split(sep).join('/')
      }).sort()
      writeFileSync(resolve(options.dir, '..', 'server-modules.json'), JSON.stringify(ids, null, 2) + '\n')
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
 * back what was there (the demo build's, or nothing): after buildApp, on process exit (a failed or thrown build) and on
 * SIGINT, SIGTERM and SIGHUP. SIGKILL can't be caught: after one, the next product build removes the stale pointer and
 * the next demo build rewrites it. It restores only a pointer into dist-product/, dist-product-test/ or
 * dist-product-eval/ (every product output, whichever mode runs; build-support/demo-deploy-redirect.ts).
 * Never run a demo and a product build at the same time, or preview or deploy while a product build runs: the pointer
 * points at the product for a moment before the restore, and a demo pointer written in between may be removed (preview
 * then fails loud; it never serves the product). The product builds are served with
 * `wrangler dev -c dist-product/inhouse_product/wrangler.json` (the product project) and
 * `-c dist-product-test/inhouse_product/wrangler.json` (the api and real projects) instead (playwright.config.ts).
 */
function keepDemoDeployRedirect(): Plugin {
  const redirect = resolve(appRoot, '.wrangler/deploy/config.json')
  let snapshot: RedirectSnapshot | null = null
  const restore = () => {
    if (!snapshot) return
    for (const outDir of Object.values(PRODUCT_OUT)) restoreRedirect(snapshot, outDir)
  }
  return {
    name: 'inhouse:keep-demo-deploy-redirect',
    apply: 'build',
    config() {
      snapshot = snapshotRedirect(redirect)
      restoreOnAnyEnd(restore)
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

/**
 * index.html's title names the demo's sample brand. The product build has no sample brand, so its page title is just
 * the product's name; the app sets per-route titles after it loads (check-product-build.mjs's canaries catch a leak).
 */
function productHtmlTitle(): Plugin {
  return {
    name: 'inhouse:product-html-title',
    transformIndexHtml(html) {
      const out = html.replace(/<title>[^<]*<\/title>/, '<title>Inhouse</title>')
      if (out === html) throw new Error('productHtmlTitle: index.html has no <title> to replace')
      return out
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const product = mode === PRODUCT || mode === PRODUCT_TEST || mode === PRODUCT_EVAL
  // The test issuer is compiled into the test and eval builds (the eval harness signs in through it); the scripted model
  // only into the test build (the eval build runs the real model); the eval trace only into the eval build.
  const testIssuer = mode === PRODUCT_TEST || mode === PRODUCT_EVAL
  return {
    plugins: [
      // The demo keeps the default config (wrangler.jsonc, worker/); each product mode names its own (server/).
      // https://developers.cloudflare.com/workers/vite-plugin/reference/api/ (configPath)
      react(), tailwindcss(), cloudflare(product ? { configPath: PRODUCT_CONFIG[mode] } : undefined), keepSourceMapsOut(), writeModuleList(),
      ...(product ? [keepDemoDeployRedirect(), productHtmlTitle(), writeServerModuleList()] : demoPublicFiles()),
    ],
    resolve: {
      alias: {
        '@client': clientEntry(product), '@sample': sampleData,
        // The test issuer (W1) only in the test and eval builds; every other build gets the switched-off stand-in, so the
        // module never enters their graph (server/auth/issuer-off.ts; check-product-build.mjs proves it).
        '@test-issuer': fileURLToPath(new URL(testIssuer ? './server/auth/test-issuer.ts' : './server/auth/issuer-off.ts', import.meta.url)),
        // The scripted model (P3, app/test/scripted-model/) the same way: only the test build's Worker can import it; every
        // other build gets server/model/scripted-off.ts (check-product-build.mjs proves it).
        '@scripted-model': fileURLToPath(new URL(mode === PRODUCT_TEST ? './test/scripted-model/index.ts' : './server/model/scripted-off.ts', import.meta.url)),
        // P4's test-build controls (server/ops/test-controls.ts, route 67) the same way: every other build gets
        // server/ops/test-controls-off.ts (check-product-build.mjs proves it).
        '@test-controls': fileURLToPath(new URL(mode === PRODUCT_TEST ? './server/ops/test-controls.ts' : './server/ops/test-controls-off.ts', import.meta.url)),
        // The eval trace (p3-eval-observability rev 2, rec 5) only in the eval build; every other build, the test build
        // included, gets server/eval-trace/off.ts (check-product-build.mjs proves the module and its canary absent).
        '@eval-trace': fileURLToPath(new URL(mode === PRODUCT_EVAL ? './server/eval-trace/on.ts' : './server/eval-trace/off.ts', import.meta.url)),
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // The Cloudflare plugin puts each environment under build.outDir: dist-product/client and dist-product/inhouse_product
    // (dist-product-test/ and dist-product-eval/ the same).
    ...(product ? { build: { outDir: PRODUCT_OUT[mode] } } : {}),
    define: {
      // The commit the build came from, sent with every client error report (src/report-error.ts).
      __RELEASE_SHA__: JSON.stringify(process.env.RELEASE_SHA || 'dev'),
      // The test issuer's compile-time switch (server/build-flags.d.ts): true only in the test and eval builds.
      __INHOUSE_TEST_BUILD__: JSON.stringify(testIssuer),
      // The eval build's switch (server/build-flags.d.ts): true only there. The egress then always takes the gateway.
      __INHOUSE_EVAL_BUILD__: JSON.stringify(mode === PRODUCT_EVAL),
    },
    environments: { client: { build: { sourcemap: 'hidden' } } },
  }
})
