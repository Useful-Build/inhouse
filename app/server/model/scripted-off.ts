// What `@scripted-model` resolves to in every build but the test build (vite.config.ts): the scripted model switched
// off, so app/test/scripted-model/ never enters the deployable Worker's module graph, whatever imports it. Same exports
// as that module (the `satisfies` checks keep them in step), with values that answer nothing. check-product-build.mjs
// fails the deployable build on any `scripted-model` module or its canary, so this file must never contain the canary.
// Owner from W3 on (p3-w3.md wires the scripted model into the egress, test builds only); PR0 adds the switch.
type Real = typeof import('../../test/scripted-model/index.ts')
export type { Miss, MessagesRequest, Scenario, ScriptedBlock, ScriptedModel, ScriptedTurn } from '../../test/scripted-model/index.ts'

export const SCRIPTED_MODEL_CANARY: string = ''
export const turnOf: Real['turnOf'] = () => {
  throw new Error('The scripted model is not in this build.')
}
export const createScriptedModel: Real['createScriptedModel'] = () => {
  throw new Error('The scripted model is not in this build.')
}
