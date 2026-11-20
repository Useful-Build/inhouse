// Clean: the names sit in a comment (inhouse.demo.v2, @sample, agent/mock) and the spec goes through fx.
import { test } from './support/fx.js'
test('x', async ({ fx }) => { await fx.seed({ theme: 'dark' }) })
