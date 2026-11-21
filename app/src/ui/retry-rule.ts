// Whether Retry can help: a refusal for who the person is (`forbidden`, `unauthorized`) won't change by asking again.
import type { AgentErrorCode } from '../agent/types'

export const canRetry = (error?: AgentErrorCode): boolean => error !== 'forbidden' && error !== 'unauthorized'
