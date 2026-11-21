// vite.config.ts's product outputs (the eval build, p3-eval-observability rev 2 rec 1). Ways it can fail, written down
// first:
//  1. a product mode writes an output folder the deploy-pointer restore doesn't name, so an eval build leaves
//     `.wrangler/deploy/config.json` pointing into dist-product-eval/ (keepDemoDeployRedirect restores every folder in
//     PRODUCT_OUT, the one list).
import { describe, expect, it } from 'vitest'
import { PRODUCT_OUT } from '../vite.config.ts'

describe('the product outputs the deploy-pointer restore covers', () => {
  it('names every product mode\'s folder, the eval build\'s included (failure 1)', () => {
    expect(PRODUCT_OUT).toEqual({ product: 'dist-product', 'product-test': 'dist-product-test', 'product-eval': 'dist-product-eval' })
  })
})
