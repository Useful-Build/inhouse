import { defineConfig, devices } from '@playwright/test'
import type { PlaywrightTestProject } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { TEST_BUILD_WORKER_CONFIG, testAccessConfig, testBuildPort, testIssuerJwks } from './e2e/support/test-build/issuer.ts'

// Artifacts go to VERIFY_DIR when it's set, else to e2e-artifacts/. Runs against the
// production build.
const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const port = Number(process.env.E2E_PORT ?? 5193)
const regression = /(visual|a11y)\.spec/
// The 30 fps motion check has its own project, added only when MOTION=1 (the `motion` workflow sets it), so
// `npm run test:e2e` and CI never run it.
const motion = /motion\.spec/
// The visual baselines are Linux only (-linux.png). On macOS outside a container the visual projects match no test, so
// nothing is compared and no -darwin.png is written. `npm run test:visual:linux` runs them in the Playwright image.
const noVisual = process.platform === 'darwin'
if (noVisual && process.env.TEST_WORKER_INDEX === undefined) {
  console.warn('Visual tests are skipped on macOS: the baselines are Linux only. Run `npm run test:visual:linux` (Playwright Docker image) instead.')
}
const ci = !!process.env.CI
// The ship specs (e2e/ship/) have their own projects, added only when SHIP=1 (the `ship` workflow sets it), so
// `npm run test:e2e` and CI never run them. Video is always on at the viewport's size and the browser is slowed so a
// person can follow it.
const ship = /e2e[\\/]ship[\\/]/
// The product build's specs (e2e/product/) run only in the `product` project, added only when E2E_PRODUCT=1, so no run
// builds the product until CI gains its product step. It serves dist-product/ (npm run build:product) on its own port
// with `wrangler dev` on the build's own Worker config: the Cloudflare plugin's .wrangler/deploy/config.json redirect,
// which `vite preview` follows, stays on the demo build (vite.config.ts). Every other project ignores e2e/product/.
// Run: npm run build:product && E2E_PRODUCT=1 npx playwright test --project=product.
const product = /e2e[\\/]product[\\/]/
const productPort = Number(process.env.E2E_PRODUCT_PORT ?? 5194)
const productURL = `http://localhost:${productPort}`
// The TEST BUILD's specs (P2, p2-design section 10): e2e/api/ (the `api` project, Playwright `request`) and e2e/real/
// (the `real-desktop` and `real-phone` projects, a browser with the CSP guard). Added only when E2E_TEST_BUILD=1; every
// other project ignores both folders. They run against dist-product-test/ (npm run build:product-test) under
// `wrangler dev` with a fresh local D1 (migrated and seeded first) and this run's test issuer key.
// Run: npm run build:product-test && E2E_TEST_BUILD=1 E2E_PREBUILT=1 npx playwright test --project=api --project=real-desktop --project=real-phone
// e2e/smoke/ (the `smoke` project, below) is ignored by every other project the same way, so it joins this pattern.
// E2E_TEST_BUILD_REMOTE: the same projects against a test build deployed elsewhere (the private ops repo's per-PR
// test-deploy workflow): BASE_URL and TEST_BUILD_INHOUSE_URL are its two origins and TEST_ISSUER_PRIVATE_JWK_FILE that
// deploy's private key (e2e/support/test-build/issuer.ts reads all three). No local server starts and no prebuilt build
// is needed; a test that reads or writes the local D1 (e2e/api/db.ts) skips itself there.
const testBuild = /e2e[\\/](api|real|smoke)[\\/]/
const testBuildRemote = !!process.env.E2E_TEST_BUILD_REMOTE
const testBuildOn = !!process.env.E2E_TEST_BUILD || testBuildRemote
if (testBuildRemote) {
  const missing = ['BASE_URL', 'TEST_BUILD_INHOUSE_URL', 'TEST_ISSUER_PRIVATE_JWK_FILE'].filter(name => !process.env[name])
  if (missing.length > 0) throw new Error(`E2E_TEST_BUILD_REMOTE=1 runs against a deployed test build and needs ${missing.join(', ')}.`)
}
const testBuildPortNumber = testBuildPort()
const visualMatch = noVisual ? { testIgnore: /.*/ } : { testMatch: /visual\.spec/, testIgnore: [ship, product, testBuild] }
const shipUse = (width: number, height: number) => ({
  ...devices['Desktop Chrome'],
  viewport: { width, height },
  video: { mode: 'on' as const, size: { width, height } },
  trace: 'on' as const,
  screenshot: 'off' as const,
  launchOptions: { slowMo: 1600 }, // a pause after every action so a person can follow; under ~3 s (a 4 s toast is checked)
})
const shipProjects: PlaywrightTestProject[] = process.env.SHIP
  ? [
      { name: 'ship-desktop', use: shipUse(1440, 900), testMatch: /e2e[\\/]ship[\\/].*\.spec\.ts$/, testIgnore: testBuild, timeout: 300_000 },
      { name: 'ship-phone', use: { ...shipUse(390, 844), hasTouch: true, isMobile: false }, testMatch: /e2e[\\/]ship[\\/].*\.spec\.ts$/, testIgnore: testBuild, timeout: 300_000 },
    ]
  : []
// BASE_URL: run against a deployed preview. No local server then.
const baseURL = process.env.BASE_URL || `http://localhost:${port}`
const motionProject: PlaywrightTestProject[] = process.env.MOTION
  ? [{ name: 'motion', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, trace: 'off', screenshot: 'off', video: 'on' }, testMatch: motion, testIgnore: testBuild }]
  : []
const productProject: PlaywrightTestProject[] = process.env.E2E_PRODUCT
  ? [{ name: 'product', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, baseURL: productURL }, testMatch: /e2e[\\/]product[\\/].*\.spec\.ts$/ }]
  : []
// The product server never builds: a build here would run beside the demo's `npm run build`, and the two share the
// Cloudflare plugin's deploy redirect. It serves the dist-product/ that `npm run build:product` wrote beforehand (CI's
// product step runs that first) and fails here, before any server starts, when it's missing. Since P2 the product build
// is the product Worker (server/, wrangler.product.jsonc), so its Worker config sits under inhouse_product/.
const productWorkerConfig = 'dist-product/inhouse_product/wrangler.json'
if (process.env.E2E_PRODUCT && !existsSync(new URL(productWorkerConfig, import.meta.url))) {
  throw new Error(`E2E_PRODUCT=1 serves the prebuilt product build, and ${productWorkerConfig} is missing. Run \`npm run build:product\` first.`)
}
// The product build's config binds Workers AI (`ai`, the egress's AI Gateway, p3-design 8.2). `wrangler dev` serves that
// binding only remotely, which needs a Cloudflare login CI doesn't have, and the product specs make no model call. So the
// product server runs on a copy without it, beside the original (its relative paths still resolve); the deployable
// wrangler.json keeps it, and scripts/check-product-build.mjs fails a product build without it.
const productServeConfig = 'dist-product/inhouse_product/wrangler.e2e.json'
if (process.env.E2E_PRODUCT) {
  const built = JSON.parse(readFileSync(new URL(productWorkerConfig, import.meta.url), 'utf8')) as Record<string, unknown>
  delete built.ai
  writeFileSync(new URL(productServeConfig, import.meta.url), JSON.stringify(built))
}
if (testBuildOn && !testBuildRemote && !existsSync(new URL(TEST_BUILD_WORKER_CONFIG, import.meta.url))) {
  throw new Error(`E2E_TEST_BUILD=1 serves the prebuilt test build, and ${TEST_BUILD_WORKER_CONFIG} is missing. Run \`npm run build:product-test\` first.`)
}
const testBuildProjects: PlaywrightTestProject[] = testBuildOn
  ? [
      { name: 'api', testMatch: /e2e[\\/]api[\\/].*\.spec\.ts$/ },
      { name: 'real-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testMatch: /e2e[\\/]real[\\/].*\.spec\.ts$/ },
      { name: 'real-phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, testMatch: /e2e[\\/]real[\\/].*\.spec\.ts$/ },
    ]
  : []
// The release smoke (e2e/smoke/, request only, read only): on the test build with E2E_TEST_BUILD=1 (CI), or against a
// release with SMOKE_BASE_URL (no local servers then, like BASE_URL). See the spec's header. Recording is off for this
// project, always: on a release the requests carry Access service-token headers, and a trace, video or report would
// keep them.
const smokeProject: PlaywrightTestProject[] = testBuildOn || process.env.SMOKE_BASE_URL
  ? [{ name: 'smoke', testMatch: /e2e[\\/]smoke[\\/].*\.spec\.ts$/, use: { trace: 'off', video: 'off', screenshot: 'off' } }]
  : []
// E2E_PREBUILT (CI): serve the build already in dist/ instead of building again.
const demoServer = {
  command: `${process.env.E2E_PREBUILT ? '' : 'npm run build && '}npx vite preview --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  reuseExistingServer: false,
  timeout: 180_000,
}
const productServer = {
  command: `npx wrangler dev --config ${productServeConfig} --port ${productPort}`,
  url: productURL,
  reuseExistingServer: false,
  timeout: 180_000,
}
// The test build's server: a fresh local D1 (prepare.mjs migrates and seeds it), then `wrangler dev` on the test build's
// own Worker config with this run's public JWKS and INHOUSE_ACCESS on this run's port, both as --var (wrangler keeps
// everything after the first ':' as the value). The private key stays in the test runner (e2e/support/test-build/issuer.ts).
const testBuildServer = () => ({
  command: [
    'node e2e/support/test-build/prepare.mjs &&',
    `npx wrangler dev --config ${TEST_BUILD_WORKER_CONFIG} --port ${testBuildPortNumber} --persist-to .wrangler/test-build`,
    `--var 'TEST_ISSUER_JWKS:${testIssuerJwks()}'`,
    `--var 'INHOUSE_ACCESS:${JSON.stringify(testAccessConfig())}'`,
  ].join(' '),
  url: `http://localhost:${testBuildPortNumber}`,
  reuseExistingServer: false,
  timeout: 180_000,
})
// BASE_URL: run the demo projects against a deployed preview, with no local demo server (SMOKE_BASE_URL: the release smoke, same). E2E_TEST_BUILD: a run of the
// test build's projects only, so no demo server either (the test-build CI job has no demo build to serve).
const webServers = [
  ...(process.env.BASE_URL || process.env.SMOKE_BASE_URL || testBuildOn ? [] : [demoServer]),
  ...(process.env.E2E_PRODUCT ? [productServer] : []),
  ...(testBuildOn && !testBuildRemote ? [testBuildServer()] : []),
]

export default defineConfig({
  testDir: './e2e',
  // Playwright specs only: e2e/support/**/*.test.ts are Vitest unit tests (vitest.config.ts runs them).
  testMatch: /\.spec\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  forbidOnly: ci,
  outputDir: `${out}/results`,
  reporter: [['list'], ['html', { outputFolder: `${out}/report`, open: 'never' }]],
  use: {
    baseURL,
    // In CI, keep traces, videos and screenshots of failed tests only.
    trace: ci ? 'retain-on-failure' : 'on',
    video: ci ? 'retain-on-failure' : 'on',
    screenshot: ci ? 'only-on-failure' : 'on',
  },
  // The regression suite (visual.spec.ts, a11y.spec.ts) runs in its own projects only. A shot fails past 100 changed
  // pixels, a fixed count, so one missing icon fails even on a tall full-page shot.
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 100 } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: [/phone/, regression, motion, ship, product, testBuild] },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, testMatch: /phone/, testIgnore: [ship, product, testBuild] },
    { name: 'visual-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, ...visualMatch },
    { name: 'visual-phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, ...visualMatch },
    { name: 'a11y', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testMatch: /a11y\.spec/, testIgnore: [ship, product, testBuild] },
    // Videos and the per-frame JSON go to <out>/results. Run: MOTION=1 npx playwright test --project=motion.
    ...motionProject,
    // Run: SHIP=1 BASE_URL=<preview> npx playwright test --project=ship-desktop --project=ship-phone.
    ...shipProjects,
    ...productProject,
    // Run: see testBuild above.
    ...testBuildProjects,
    ...smokeProject,
  ],
  webServer: webServers.length ? webServers : undefined,
})
