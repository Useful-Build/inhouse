// The job texts (Stage 1, N3 and N20): the message the server itself sends to carry a long job on, after a turn hit its
// step, spend or time limit (`carryOn`) or after a turn was cut off by a crash, a restart or an error on our side
// (`afterCutOff`, N4). The person never typed these, so each one says it is an automatic note from Inhouse, not a
// message from the person.
// Wired into the job engine through `compose.ts` (`jobDeps`); while that port was null no turn became a job.
// Orchestrator text: a change is a new SYSTEM_PROMPT_VERSION with eval results.
import type { JobTexts } from '../do/brand-agent/jobs/types.ts'

/** Every job text starts with this, so neither the agent nor a reader of the chat takes it for the person's words. */
export const JOB_NOTE_PREFIX = '[Automatic note from Inhouse, not a message from the person]'

const CARRY_ON =
  'Your last turn reached its limit before the task was finished, so Inhouse is carrying the task on as a long job. ' +
  "Continue the person's last request from where you stopped. Don't start over, don't repeat work that is already done, " +
  "and don't ask whether to continue. When the whole task is done, give the person your final answer."

const CUT_OFF =
  'Your last turn was cut off before it finished (for example by a restart), so Inhouse is carrying the task on as a long job. ' +
  'Your last step may not have completed, and files written since your last saved step may be missing: check the files ' +
  "and results you rely on before using them. Then continue the person's last request from where you stopped. Don't " +
  "start over and don't ask whether to continue. When the whole task is done, give the person your final answer."

/** `n` is the continuation's place in the job (1 for the first); the words don't change with it. */
export const JOB_TEXTS: JobTexts = {
  carryOn: () => `${JOB_NOTE_PREFIX} ${CARRY_ON}`,
  afterCutOff: () => `${JOB_NOTE_PREFIX} ${CUT_OFF}`,
}
