// Stage 1: whether `question_ask` is offered to the agent at all. M2-Q built it off in every deployable build, because a
// question waits on a person and, with no screen to answer it, would block its chat (`waiting_answer`) until a reset or
// the 7-day expiry. M2-H ships that screen (Approvals' "Questions for you", routes 140 and 141), so it is on in every
// build: product, house, brand, eval and test. Off (`false`) still means what it did: the `inhouse` server doesn't list
// it and refuses a call to it, and a deferral of it is resumed at once with nothing asked (server/questions/ask.ts
// `questionHook`). That path stays tested, so this line is the way to take questions away again.

/** This build's answer: on everywhere since M2-H. */
export const QUESTIONS_ON: boolean = true
