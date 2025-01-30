import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { socialRoutes } from '../../social.js';

// Mock Redis with in-memory store
const mockCache = new Map();
mock.module('../../cache.js', () => ({
  readFromRedis: async (key: string) => mockCache.get(key),
  saveToRedis: async (key: string, value: any) => mockCache.set(key, value),
  client: {
    get: async (key: string) => mockCache.get(key),
    set: async (key: string, value: any) => mockCache.set(key, value),
    isReady: true,
  },
}));

// Mock MongoDB with error injection
let shouldFail = false;
mock.module('../../db.js', () => ({
  getDbo: async () => ({
    collection: () => ({
      aggregate: () => ({
        toArray: async () => {
          if (shouldFail) {
            throw new Error('Database connection failed');
          }
          return []; // Return empty array by default
        },
      }),
    }),
  }),
}));

describe('/channels', () => {
  beforeEach(() => {
    mockCache.clear();
    shouldFail = false;
  });

  test('success: returns cached channels', async () => {
    // Set mock cache data
    mockCache.set('channels', {
      type: 'channels',
      value: [
        {
          channel: 'test',
          creator: 'siggi@handcash.io',
          last_message: 'testing',
          last_message_time: 1734657002,
          messages: 1547,
        },
      ],
    });

    const response = await socialRoutes.handle(new Request('http://localhost/channels'));

    expect(response.status).toBe(200);
    expect(await response.json()).toBeArray();
  });

  test('success: fetches from MongoDB', async () => {
    const response = await socialRoutes.handle(new Request('http://localhost/channels'));

    expect(response.status).toBe(200);
    expect(await response.json()).toBeArray();
  });

  test('error: handles MongoDB failures', async () => {
    shouldFail = true;

    const response = await socialRoutes.handle(new Request('http://localhost/channels'));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch channels',
    });
  });
});
