// Hub-wide ambient declarations (no import or export, so this file is global).

/**
 * The test build's switch, a wrangler `define`: "false" in wrangler.hub.jsonc (esbuild drops every branch it guards),
 * "true" in wrangler.hub.test.jsonc. vitest.config.ts defines it per project the same way.
 */
declare const __INHOUSE_HUB_TEST__: boolean
