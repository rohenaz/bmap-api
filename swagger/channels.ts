import { t } from 'elysia';
import type { OpenAPIV3 } from 'openapi-types';

export const ChannelResponseSchema = t.Array(
  t.Object({
    channel: t.String(),
    creator: t.Union([t.String(), t.Null()]),
    last_message: t.Union([t.String(), t.Null()]),
    last_message_time: t.Number(),
    messages: t.Number(),
  })
);

export const channelsEndpointDetail: OpenAPIV3.OperationObject = {
  tags: ['social'],
  description: 'Get list of all message channels',
  summary: 'List channels',
  responses: {
    '200': {
      description: 'List of channels with their latest messages',
      content: {
        'application/json': {
          schema: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                channel: {
                  type: 'string' as const,
                  description: 'Channel identifier',
                },
                creator: {
                  type: 'string' as const,
                  nullable: true,
                  description: 'Channel creator paymail',
                },
                last_message: {
                  type: 'string' as const,
                  nullable: true,
                  description: 'Most recent message',
                },
                last_message_time: {
                  type: 'number' as const,
                  description: 'Timestamp of last message',
                },
                messages: {
                  type: 'number' as const,
                  description: 'Total message count',
                },
              },
            },
          },
        },
      },
    },
    '500': {
      description: 'Internal Server Error',
      content: {
        'application/json': {
          schema: {
            type: 'array' as const,
            items: {
              type: 'object' as const,
              properties: {
                channel: {
                  type: 'string' as const,
                  description: 'Channel identifier',
                },
                creator: {
                  type: 'string' as const,
                  nullable: true,
                  description: 'Channel creator paymail',
                },
                last_message: {
                  type: 'string' as const,
                  nullable: true,
                  description: 'Most recent message',
                },
                last_message_time: {
                  type: 'number' as const,
                  description: 'Timestamp of last message',
                },
                messages: {
                  type: 'number' as const,
                  description: 'Total message count',
                },
              },
            },
          },
        },
      },
    },
  },
};
