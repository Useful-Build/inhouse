import { defineConfig } from 'vitest/config'

// The runner's own tests. They run with the runner's node_modules, never the app's.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
})
