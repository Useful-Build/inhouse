// Local copy of a Gorgias-shaped helpdesk tool list for M4-K2 snapshot testing.
// M4-F's fixture under app/test/upstreams/mcp/ is not on origin/main yet; this mirrors N52's helpdesk profile
// (search, get, reply and macro as writes) with realistic nested schemas, enums, local $refs and unions.
import type { ToolSchemaDescriptor } from '../types-gen'

export const HELPDESK_FIXTURE_TOOLS: readonly ToolSchemaDescriptor[] = [
  {
    server: 'helpdesk',
    name: 'tickets_search',
    mode: 'read',
    description: 'Search helpdesk tickets by status, channel, tags, or query text.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search query across ticket subject and messages.' },
        status: { type: 'string', enum: ['open', 'pending', 'closed'], description: 'Filter by ticket status.' },
        channel: { type: 'string', enum: ['email', 'chat', 'sms', 'voice'] },
        tags: { type: 'array', items: { type: 'string' }, description: 'Require tickets to carry all listed tags.' },
        createdAfter: { type: 'string', description: 'ISO-8601 timestamp lower bound.' },
        limit: { type: 'integer', description: 'Maximum results per page (1-50).' },
        cursor: { type: 'string' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        tickets: {
          type: 'array',
          items: { $ref: '#/$defs/TicketSummary' },
        },
        nextCursor: { type: ['string', 'null'] },
      },
      required: ['tickets', 'nextCursor'],
      additionalProperties: false,
      $defs: {
        TicketSummary: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            subject: { type: 'string' },
            status: { type: 'string', enum: ['open', 'pending', 'closed'] },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
            customer: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                name: { type: 'string' },
                email: { type: 'string' },
              },
              required: ['id', 'email'],
              additionalProperties: false,
            },
            tags: { type: 'array', items: { type: 'string' } },
            updatedAt: { type: 'string' },
          },
          required: ['id', 'subject', 'status', 'customer', 'tags', 'updatedAt'],
          additionalProperties: false,
        },
      },
    },
  },
  {
    server: 'helpdesk',
    name: 'ticket_get',
    mode: 'read',
    description: 'Read a single helpdesk ticket with customer details and message thread.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'integer', description: 'Numeric ticket ID.' },
        includeInternalNotes: { type: 'boolean', description: 'Include private agent notes.' },
      },
      required: ['ticketId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        subject: { type: 'string' },
        status: { type: 'string', enum: ['open', 'pending', 'closed'] },
        customer: { $ref: '#/$defs/Customer' },
        messages: { type: 'array', items: { $ref: '#/$defs/Message' } },
      },
      required: ['id', 'subject', 'status', 'customer', 'messages'],
      additionalProperties: false,
      $defs: {
        Customer: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            email: { type: 'string' },
            orderIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['id', 'email'],
          additionalProperties: false,
        },
        Message: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            sender: {
              oneOf: [
                {
                  type: 'object',
                  properties: {
                    kind: { const: 'customer' },
                    email: { type: 'string' },
                  },
                  required: ['kind', 'email'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: {
                    kind: { const: 'agent' },
                    agentId: { type: 'integer' },
                    name: { type: 'string' },
                  },
                  required: ['kind', 'agentId'],
                  additionalProperties: false,
                },
              ],
            },
            bodyText: { type: 'string' },
            internal: { type: 'boolean' },
            createdAt: { type: 'string' },
          },
          required: ['id', 'sender', 'bodyText', 'createdAt'],
          additionalProperties: false,
        },
      },
    },
  },
  {
    server: 'helpdesk',
    name: 'ticket_reply',
    mode: 'write',
    description: 'Send a public reply or internal note on a helpdesk ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'integer', description: 'Numeric ticket ID.' },
        bodyText: { type: 'string', description: 'Plain-text body of the reply.' },
        channel: { type: 'string', enum: ['email', 'chat'] },
        internalNote: { type: 'boolean', description: 'When true, posts as an internal agent note.' },
      },
      required: ['ticketId', 'bodyText'],
      additionalProperties: false,
    },
  },
  {
    server: 'helpdesk',
    name: 'ticket_macro_apply',
    mode: 'write',
    description: 'Apply a helpdesk macro to a ticket with optional template variables.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'integer', description: 'Numeric ticket ID.' },
        macroId: { type: 'string', description: 'Identifier of the macro to apply.' },
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional key-value variables substituted into the macro.',
        },
      },
      required: ['ticketId', 'macroId'],
      additionalProperties: false,
    },
  },
]
