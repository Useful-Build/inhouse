import { defineConfig, devices } from '@playwright/test'
import type { PlaywrightTestProject } from '@playwright/test'

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
const visualMatch = noVisual ? { testIgnore: /.*/ } : { testMatch: /visual\.spec/ }
const ci = !!process.env.CI
// The ship specs (e2e/ship/) have their own projects, added only when SHIP=1 (the `ship` workflow sets it), so
// `npm run test:e2e` and CI never run them. Video is always on at the viewport's size and the browser is slowed so a
// person can follow it.
const ship = /e2e[\\/]ship[\\/]/
const shipUse = (width: number, height: number) => ({
  ...devices['Desktop Chrome'],
  viewport: { width, height },
  video: { mode: 'on' as const, size: { width, height } },
  trace: 'on' as const,
  screenshot: 'off' as const,
  launchOptions: { slowMo: 250 },
})
const shipProjects: PlaywrightTestProject[] = process.env.SHIP
  ? [
      { name: 'ship-desktop', use: shipUse(1440, 900), testMatch: /e2e[\\/]ship[\\/].*\.spec\.ts$/, timeout: 120_000 },
      { name: 'ship-phone', use: { ...shipUse(390, 844), hasTouch: true, isMobile: false }, testMatch: /e2e[\\/]ship[\\/].*\.spec\.ts$/, timeout: 120_000 },
    ]
  : []
// BASE_URL: run against a deployed preview. No local server then.
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`
const motionProject: PlaywrightTestProject[] = process.env.MOTION
  ? [{ name: 'motion', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, trace: 'off', screenshot: 'off', video: 'on' }, testMatch: motion }]
  : []

export default defineConfig({
  testDir: './e2e',
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
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: [/phone/, regression, motion, ship] },
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, testMatch: /phone/, testIgnore: ship },
    { name: 'visual-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, ...visualMatch },
    { name: 'visual-phone', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: false }, ...visualMatch },
    { name: 'a11y', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testMatch: /a11y\.spec/ },
    // Videos and the per-frame JSON go to <out>/results. Run: MOTION=1 npx playwright test --project=motion.
    ...motionProject,
    // Run: SHIP=1 BASE_URL=<preview> npx playwright test --project=ship-desktop --project=ship-phone.
    ...shipProjects,
  ],
  webServer: process.env.BASE_URL ? undefined : {
    // E2E_PREBUILT (CI): serve the build already in dist/ instead of building again.
    command: `${process.env.E2E_PREBUILT ? '' : 'npm run build && '}npx vite preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
