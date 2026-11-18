import { defineConfig, devices } from '@playwright/test'

// Artifacts go to VERIFY_DIR when it's set, else to e2e-artifacts/. Runs against the
// production build.
const out = process.env.VERIFY_DIR ?? 'e2e-artifacts'
const port = Number(process.env.E2E_PORT ?? 5193)
const regression = /(visual|a11y)\.spec/
// The visual baselines are Linux only (-linux.png). On macOS outside a container the visual projects match no test, so
// nothing is compared and no -darwin.png is written. `npm run test:visual:linux` runs them in the Playwright image.
const noVisual = process.platform === 'darwin'
if (noVisual && process.env.TEST_WORKER_INDEX === undefined) {
  console.warn('Visual tests are skipped on macOS: the baselines are Linux only. Run `npm run test:visual:linux` (Playwright Docker image) instead.')
}
const visualMatch = noVisual ? { testIgnore: /.*/ } : { testMatch: /visual\.spec/ }
const ci = !!process.env.CI

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  outputDir: `${out}/results`,
  reporter: [['list'], ['html', { outputFolder: `${out}/report`, open: 'never' }]],
  use: {
    baseURL: `http://localhost:${port}`,
    // In CI, keep traces, videos and screenshots of failed tests only.
    trace: ci ? 'retain-on-failure' : 'on',
    video: ci ? 'retain-on-failure' : 'on',
    screenshot: ci ? 'only-on-failure' : 'on',
  },
  // The regression suite (visual.spec.ts, a11y.spec.ts) runs in its own projects only. A shot fails past 100 changed
  // pixels, a fixed count, so one missing icon fails even on a tall full-page shot.
  expect: { toHaveScreenshot: { animations: 'disabled', caret: 'hide', maxDiffPixels: 100 } },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: [/phone/, regression] },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, testMatch: /phone/ },
    { name: 'visual-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, ...visualMatch },
    { name: 'visual-phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, ...visualMatch },
    { name: 'a11y', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testMatch: /a11y\.spec/ },
  ],
  webServer: {
    // E2E_PREBUILT (CI): serve the build already in dist/ instead of building again.
    command: `${process.env.E2E_PREBUILT ? '' : 'npm run build && '}npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
