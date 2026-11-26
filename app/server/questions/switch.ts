// Stage 1 M2-Q: whether `question_ask` is offered to the agent at all. A question waits on a person, and until M2-H
// ships the screen to answer it a question would block its chat (`waiting_answer`) with no way out but a reset or the
// 7-day expiry. So it is off in every deployable build (product, house, brand, and the eval build, which measures the
// product's behaviour), and on only in the test build, where the specs answer through route 141. Off means: the `inhouse`
// server doesn't list it and refuses a call to it, and a deferral of it is resumed at once with nothing asked
// (server/questions/ask.ts `questionHook`). M2-H turns it on together with the UI.
declare const __INHOUSE_TEST_BUILD__: boolean
declare const __INHOUSE_EVAL_BUILD__: boolean

/** The rule, over the build's compile-time flags (server/build-flags.d.ts): the test build only. */
export function questionsOn(compiled: { test: boolean; eval: boolean } = { test: __INHOUSE_TEST_BUILD__, eval: __INHOUSE_EVAL_BUILD__ }): boolean {
  return compiled.test && !compiled.eval
}

/** This build's answer: a compile-time constant, `false` in the product build. */
export const QUESTIONS_ON: boolean = questionsOn()
