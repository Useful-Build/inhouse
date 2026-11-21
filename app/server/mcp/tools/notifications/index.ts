// The notifications tool (agent-tools "6. Notifications", P5 W4): notification_send. Its name and description are the
// registry's (server/mcp/registry.ts); its input and answer are here.
import type { InhouseToolName, ToolHandler } from '../../server/tool.ts'
import { notificationSend } from './send.ts'

export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = { notification_send: notificationSend }
