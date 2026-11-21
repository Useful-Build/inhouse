// Compile-time flags vite.config.ts defines. `__INHOUSE_TEST_BUILD__` is true only in `vite build --mode product-test`
// and `--mode product-eval`, so every other build drops the test issuer (p2-design section 10);
// scripts/check-product-build.mjs proves it. `__INHOUSE_EVAL_BUILD__` is true only in `--mode product-eval`: the egress
// then always takes the gateway, never the scripted model (p3-eval-observability rev 2, rec 1).
declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean
