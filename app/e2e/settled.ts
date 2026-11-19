import type { Page } from '@playwright/test'

/**
 * Resolves once every finite animation and transition has finished and two frames have drawn.
 * Endless animations (spinners, the ambient mark) are skipped, so this can't hang on them.
 * Use it where a test used to sleep before a screenshot or a layout read.
 */
export const settled = (page: Page) => page.evaluate(async () => {
  const finite = () => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity && a.playState !== 'finished')
  for (let pending = finite(); pending.length; pending = finite()) await Promise.all(pending.map(a => a.finished.catch(() => undefined)))
  await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
})
