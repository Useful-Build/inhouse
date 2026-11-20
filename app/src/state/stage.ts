import { STAGES } from '../agent/types'
import type { Stage } from '../agent/types'

/**
 * The product's stage: the agent's technical `stage` setting. A missing or unknown value fails closed to the most
 * restrictive stage (the first in STAGES, Watch), never to Act: a locked row stays locked until the setting says otherwise.
 */
export const productStage = (settings: Readonly<Record<string, string>>): Stage => STAGES.find(x => x === settings.stage) ?? STAGES[0]!
