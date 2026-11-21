// What the test build's specs import. The `real` project's specs: `import { expect, test } from '../support/test-build/index.js'`
// (the CSP guard from e2e/csp.ts is on for every one of them). The `api` project's specs use Playwright's `request`
// with `appOrigin` and `signIn`.
export { expect, test } from '../../csp.js'
export { appOrigin, signIn } from './issuer.js'
export type { AppName } from './issuer.js'
