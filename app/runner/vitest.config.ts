import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The runner's own tests. They run with the runner's node_modules, never the app's: app/shared/protocol/ imports zod,
// which resolves to the runner's copy here (as it does in the build).
export default defineConfig({
  // zod's ESM entry, as the build bundles it (package.json's build script), so tests and the image run one flavour.
  resolve: {
    alias: { zod: fileURLToPath(new URL('./node_modules/zod/index.js', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
