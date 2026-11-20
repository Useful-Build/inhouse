// Compile-time flags vite.config.ts defines. `__INHOUSE_TEST_BUILD__` is true only in `vite build --mode product-test`,
// so every other build drops the test issuer (p2-design section 10); scripts/check-product-build.mjs proves it.
declare const __INHOUSE_TEST_BUILD__: boolean
