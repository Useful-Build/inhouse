import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { cloudflare } from "@cloudflare/vite-plugin";

const sampleData = fileURLToPath(new URL('./src/agent/sample-data', import.meta.url))

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
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
      for (const file of walk(assetsDir).filter(f => f.endsWith('.map'))) {
        const to = join(mapsDir, relative(assetsDir, file))
        mkdirSync(dirname(to), { recursive: true })
        renameSync(file, to)
      }
      writeFileSync(join(assetsDir, '.assetsignore'), '*.map\n')
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), keepSourceMapsOut()],
  resolve: { alias: { '@sample': sampleData, '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The commit the build came from, sent with every client error report (src/report-error.ts).
  define: { __RELEASE_SHA__: JSON.stringify(process.env.RELEASE_SHA || 'dev') },
  environments: { client: { build: { sourcemap: 'hidden' } } },
})
