import { t } from 'elysia';
import type { OpenAPIV3 } from 'openapi-types';

export const FriendResponseSchema = t.Object({
  friends: t.Array(
    t.Object({
      bapID: t.String(),
      mePublicKey: t.String(),
      themPublicKey: t.String(),
    })
  ),
  incoming: t.Array(t.String()),
  outgoing: t.Array(t.String()),
});

export const friendEndpointDetail: OpenAPIV3.OperationObject = {
  tags: ['social'],
  description: 'Get friend relationships for a BAP ID',
  summary: 'Get friends',
  parameters: [
    {
      name: 'bapId',
      in: 'path',
      required: true,
      schema: {
        type: 'string' as const,
      },
      description: 'BAP Identity Key',
    },
  ],
  responses: {
    '200': {
      description: 'Friend relationships',
      content: {
        'application/json': {
          schema: {
            type: 'object' as const,
            properties: {
              friends: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Mutual friends (BAP IDs)',
              },
              incoming: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Incoming friend requests (BAP IDs)',
              },
              outgoing: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Outgoing friend requests (BAP IDs)',
              },
            },
          },
        },
      },
    },
    '400': {
      description: 'Bad Request - Missing BAP ID parameter',
      content: {
        'application/json': {
          schema: {
            type: 'object' as const,
            properties: {
              friends: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
              incoming: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
              outgoing: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
            },
          },
        },
      },
    },
    '404': {
      description: 'Not Found - BAP ID does not exist or cannot be found',
      content: {
        'application/json': {
          schema: {
            type: 'object' as const,
            properties: {
              friends: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
              incoming: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
              outgoing: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
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
            type: 'object' as const,
            properties: {
              friends: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
              incoming: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
              outgoing: {
                type: 'array' as const,
                items: { type: 'string' as const },
                description: 'Empty array',
              },
            },
          },
        },
      },
    },
  },
};
