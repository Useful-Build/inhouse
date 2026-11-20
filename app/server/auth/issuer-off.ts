// What `@test-issuer` resolves to in every build but the test build (vite.config.ts): the test issuer switched off, so
// server/auth/test-issuer.ts (W1) never enters the deployable Worker's module graph, whatever imports it.
// W1: import the test issuer only as `@test-issuer`, never by its path, and give this file the same exports as
// test-issuer.ts with values that trust nothing (tsconfig.server.json types `@test-issuer` from test-issuer.ts, so
// add `satisfies` checks here). check-product-build.mjs fails the deployable build on any `test-issuer` module.
export {}
