import { t } from 'elysia';
import type { OpenAPIV3 } from 'openapi-types';

export const MessageQuery = t.Object({
  page: t.Optional(t.String()),
  limit: t.Optional(t.String()),
});

export const ChannelMessageSchema = t.Object({
  channel: t.String(),
  page: t.Number(),
  limit: t.Number(),
  count: t.Number(),
  results: t.Array(
    t.Object({
      tx: t.Object({
        h: t.String(),
      }),
      blk: t.Object({
        i: t.Number(),
        t: t.Number(),
      }),
      MAP: t.Array(
        t.Object({
          app: t.String(),
          type: t.String(),
          channel: t.String(),
          paymail: t.String(),
        })
      ),
      B: t.Array(
        t.Object({
          encoding: t.String(),
          Data: t.Object({
            utf8: t.String(),
            data: t.Optional(t.String()),
          }),
        })
      ),
      AIP: t.Optional(
        t.Array(
          t.Object({
            address: t.Optional(t.String()),
            algorithm_signing_component: t.Optional(t.String()),
          })
        )
      ),
    })
  ),
  signers: t.Array(
    t.Object({
      idKey: t.String(),
      rootAddress: t.String(),
      currentAddress: t.String(),
      addresses: t.Array(
        t.Object({
          address: t.String(),
          txId: t.String(),
          block: t.Optional(t.Number()),
        })
      ),
      identity: t.String(),
      identityTxId: t.String(),
      block: t.Number(),
      timestamp: t.Number(),
      valid: t.Boolean(),
    })
  ),
});

export const channelMessagesEndpointDetail: OpenAPIV3.OperationObject = {
  tags: ['social'],
  description: 'Get messages from a specific channel',
  summary: 'Get channel messages',
  parameters: [
    {
      name: 'channelId',
      in: 'path',
      required: true,
      schema: { type: 'string' as const },
      description: 'Channel identifier',
    },
    {
      name: 'page',
      in: 'query',
      schema: { type: 'string' as const },
      description: 'Page number for pagination',
    },
    {
      name: 'limit',
      in: 'query',
      schema: { type: 'string' as const },
      description: 'Number of messages per page',
    },
  ],
  responses: {
    '200': {
      description: 'Channel messages with signer information',
      content: {
        'application/json': {
          schema: {
            type: 'object' as const,
            properties: {
              channel: { type: 'string' as const },
              page: { type: 'number' as const },
              limit: { type: 'number' as const },
              count: { type: 'number' as const },
              results: {
                type: 'array' as const,
                items: {
                  type: 'object' as const,
                  properties: {
                    tx: {
                      type: 'object' as const,
                      properties: {
                        h: { type: 'string' as const },
                      },
                    },
                    blk: {
                      type: 'object' as const,
                      properties: {
                        i: { type: 'number' as const },
                        t: { type: 'number' as const },
                      },
                    },
                    MAP: {
                      type: 'array' as const,
                      items: {
                        type: 'object' as const,
                        properties: {
                          app: { type: 'string' as const },
                          type: { type: 'string' as const },
                          channel: { type: 'string' as const },
                          paymail: { type: 'string' as const },
                        },
                      },
                    },
                    B: {
                      type: 'array' as const,
                      items: {
                        type: 'object' as const,
                        properties: {
                          encoding: { type: 'string' as const },
                          Data: {
                            type: 'object' as const,
                            properties: {
                              utf8: { type: 'string' as const },
                              data: { type: 'string' as const },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
              signers: {
                type: 'array' as const,
                items: {
                  $ref: '#/components/schemas/BapIdentity',
                },
              },
            },
          },
        },
      },
    },
    '400': {
      description: 'Bad Request - Invalid parameters',
      content: {
        'application/json': {
          schema: {
            type: 'object' as const,
            properties: {
              error: { type: 'string' as const },
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
              channel: { type: 'string' as const },
              page: { type: 'number' as const },
              limit: { type: 'number' as const },
              count: { type: 'number' as const },
              results: { type: 'array' as const, items: {} },
              signers: { type: 'array' as const, items: {} },
            },
          },
        },
      },
    },
  },
};
