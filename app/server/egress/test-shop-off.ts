// What `@test-shop` resolves to in every build but the test and eval builds (vite.config.ts): no shop override, so
// ./test-shop.ts (and the hub option's name) never enters the deployable Worker's module graph, whatever imports it. Same
// exports as that file (typed from it). check-product-build.mjs fails the deployable build on that module, its canary or the
// option's name, so this file must contain none of them.
type Real = typeof import('./test-shop.ts')

export const TEST_SHOP_CANARY: Real['TEST_SHOP_CANARY'] = ''
export const TEST_SHOP_OWNER: Real['TEST_SHOP_OWNER'] = ''
export const TEST_SHOP_KEY: Real['TEST_SHOP_KEY'] = ''
export const readTestShop: Real['readTestShop'] = () => {
  throw new Error('The test shop override is not in this build.')
}
/** The hub as it is: every read call goes to the hub's own shop. */
export const withTestShop: Real['withTestShop'] = hub => hub
