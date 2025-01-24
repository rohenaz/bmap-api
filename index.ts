import { fileURLToPath } from 'node:url';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { swagger } from '@elysiajs/swagger';
import type { Static } from '@sinclair/typebox';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Elysia, NotFoundError, t } from 'elysia';
import type { ChangeStreamDocument, Document, Sort, SortDirection } from 'mongodb';

import type { BmapTx, BobTx } from 'bmapjs';
import bmapjs from 'bmapjs';
import { parse } from 'bpu-ts';

import './p2p.js';
import { type BapIdentity, getBAPIdByAddress, resolveSigners } from './bap.js';
import {
  type CacheCount,
  type CacheValue,
  client,
  deleteFromCache,
  getBlockHeightFromCache,
  readFromRedis,
  saveToRedis,
} from './cache.js';
import { getBlocksRange, getTimeSeriesData } from './chart.js';
import { getCollectionCounts, getDbo, getState } from './db.js';
import { processTransaction } from './process.js';
import { parseIdentity } from './social.js';
import { explorerTemplate } from './src/components/explorer.js';
import { Timeframe } from './types.js';

import type { ChangeStream } from 'mongodb';
import { htmxRoutes } from './htmx.js';
import { socialRoutes } from './social.js';

dotenv.config();

const { allProtocols, TransformTx } = bmapjs;
const __filename = fileURLToPath(import.meta.url);

// Define request types
const QueryParams = t.Object({
  collectionName: t.String(),
  base64Query: t.String(),
});

const TxParams = t.Object({
  tx: t.String(),
  format: t.Optional(t.String()),
});

const ChartParams = t.Object({
  name: t.Optional(t.String()),
  timeframe: t.Optional(t.String()),
});

const IngestBody = t.Object({
  rawTx: t.String(),
});

type IngestRequest = Static<typeof IngestBody>;

// Transaction utility functions
const bobFromRawTx = async (rawtx: string) => {
  try {
    const result = await parse({
      tx: { r: rawtx },
      split: [{ token: { op: 106 }, include: 'l' }, { token: { s: '|' } }],
    });
    if (!result) throw new Error('No result from parsing transaction');
    return result;
  } catch (error) {
    console.error('Error parsing raw transaction:', error);
    throw new Error(
      `Failed to parse transaction: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const jsonFromTxid = async (txid: string) => {
  try {
    const url = `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`;
    console.log('Fetching from WoC:', url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WhatsonChain request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (error) {
    console.error('Error fetching from WhatsonChain:', error);
    throw new Error(
      `Failed to fetch from WhatsonChain: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const rawTxFromTxid = async (txid: string) => {
  try {
    const url = `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`;
    console.log('Fetching raw tx from WoC:', url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WhatsonChain request failed: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    if (!text) {
      throw new Error('Empty response from WhatsonChain');
    }
    return text;
  } catch (error) {
    console.error('Error fetching raw tx from WhatsonChain:', error);
    throw new Error(
      `Failed to fetch raw tx: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const bobFromTxid = async (txid: string) => {
  try {
    const rawtx = await rawTxFromTxid(txid);
    try {
      return await bobFromRawTx(rawtx);
    } catch (e) {
      throw new Error(
        `Failed to get rawtx from whatsonchain for ${txid}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  } catch (error) {
    console.error('Error in bobFromTxid:', error);
    throw new Error(
      `Failed to process transaction: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

// Create and configure the Elysia app using method chaining
const app = new Elysia()
  // Plugins
  .use(cors())
  .use(staticPlugin({ assets: './public', prefix: '/' }))
  .use(
    swagger({
      documentation: {
        info: {
          title: 'BMAP API',
          version: '1.0.0',
          description: 'Bitcoin transaction processing and social features API',
        },
        tags: [
          { name: 'query', description: 'MongoDB query and text search endpoints' },
          { name: 'transactions', description: 'Transaction processing and retrieval' },
          { name: 'social', description: 'Social features like friends, likes, and channels' },
          { name: 'charts', description: 'Chart data generation endpoints' },
          { name: 'identities', description: 'BAP identity management' },
          { name: 'htmx', description: 'HTMX-powered dynamic UI updates' },
        ],
        security: [{ apiKey: [] }],
        components: {
          schemas: {
            Query: {
              type: 'object',
              properties: {
                v: { type: 'number' },
                q: {
                  type: 'object',
                  properties: {
                    find: { type: 'object' },
                    aggregate: { type: 'array', items: { type: 'object' } },
                    sort: { type: 'object' },
                    limit: { type: 'number' },
                    project: { type: 'object' },
                  },
                },
              },
            },
            BapIdentity: {
              type: 'object',
              properties: {
                idKey: { type: 'string', description: 'BAP Identity Key' },
                rootAddress: { type: 'string', description: 'Root Bitcoin address' },
                currentAddress: { type: 'string', description: 'Current active Bitcoin address' },
                addresses: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      address: { type: 'string', description: 'Bitcoin address' },
                      txId: {
                        type: 'string',
                        description: 'Transaction ID where address was claimed',
                      },
                      block: {
                        type: 'number',
                        description: 'Block height of claim',
                        nullable: true,
                      },
                    },
                  },
                },
                identity: { type: 'string', description: 'Identity data JSON string' },
                identityTxId: { type: 'string', description: 'Transaction ID of identity claim' },
                block: { type: 'number', description: 'Block height of identity registration' },
                timestamp: { type: 'number', description: 'Unix timestamp of registration' },
                valid: { type: 'boolean', description: 'Whether the identity is valid' },
              },
              required: ['idKey', 'rootAddress', 'currentAddress', 'addresses'],
            },
          },
        },
      },
      path: '/docs', // Serve Swagger UI at /docs
    })
  )
  // Derived context, e.g. SSE request timeout
  .derive(() => ({
    requestTimeout: 0,
  }))

  // Lifecycle hooks
  .onRequest(({ request }) => {
    // Only log 404s and errors, but we can log all requests if you prefer
    console.log(chalk.gray(`${request.method} ${request.url}`));
  })
  .onError(({ error, request }) => {
    console.log({ error });

    if (error instanceof NotFoundError) {
      console.log(chalk.yellow(`404: ${request.method} ${request.url}`));
      return new Response(`<div class="text-yellow-500">Not Found: ${request.url}</div>`, {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Handle validation errors
    if ('code' in error && error.code === 'VALIDATION') {
      console.log('Validation error details:', error);
      console.log('Request URL:', request.url);
      console.log('Request method:', request.method);
      const errorMessage = 'message' in error ? error.message : 'Validation Error';
      return new Response(`<div class="text-orange-500">Validation Error: ${errorMessage}</div>`, {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Handle parse errors
    if ('code' in error && error.code === 'PARSE') {
      const errorMessage = 'message' in error ? error.message : 'Parse Error';
      return new Response(`<div class="text-red-500">Parse Error: ${errorMessage}</div>`, {
        status: 400,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Other errors
    console.error(chalk.red(`Error: ${request.method} ${request.url}`), error);
    const errorMessage = 'message' in error ? error.message : 'Internal Server Error';
    return new Response(`<div class="text-red-500">Server error: ${errorMessage}</div>`, {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    });
  })
  .use(socialRoutes)
  .use(htmxRoutes)
  // Routes
  .get(
    '/s/:collectionName?/:base64Query',
    async ({ params, set }) => {
      const { collectionName, base64Query: b64 } = params;

      Object.assign(set.headers, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      });

      try {
        const json = Buffer.from(b64, 'base64').toString();
        const db = await getDbo();

        console.log(chalk.blue('New change stream subscription on', collectionName));
        const query = JSON.parse(json);

        const pipeline = [{ $match: { operationType: 'insert' } }];
        const keys = Object.keys(query.q.find || {});
        for (const k of keys) {
          pipeline[0].$match[`fullDocument.${k}`] = query.q.find[k];
        }

        let changeStream: ChangeStream | undefined;
        const messageQueue: string[] = [];
        let isActive = true;

        async function* eventGenerator() {
          try {
            if (collectionName === '$all') {
              changeStream = db.watch(pipeline, { fullDocument: 'updateLookup' });
            } else {
              const target = db.collection(collectionName);
              changeStream = target.watch(pipeline, { fullDocument: 'updateLookup' });
            }

            yield `data: ${JSON.stringify({ type: 'open', data: [] })}\n\n`;

            changeStream.on('change', (next: ChangeStreamDocument<BmapTx>) => {
              if (next.operationType === 'insert' && isActive) {
                const eventType = collectionName === '$all' ? next.ns.coll : collectionName;
                messageQueue.push(
                  `data: ${JSON.stringify({ type: eventType, data: [next.fullDocument] })}\n\n`
                );
              }
            });

            changeStream.on('error', (error) => {
              console.error(chalk.red('Change stream error:'), error);
              isActive = false;
            });

            changeStream.on('close', () => {
              console.log(chalk.blue('Change stream closed'));
              isActive = false;
            });

            while (isActive) {
              while (messageQueue.length > 0) {
                yield messageQueue.shift();
              }
              yield ':heartbeat\n\n';
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          } finally {
            isActive = false;
            if (changeStream) {
              try {
                await changeStream.close();
              } catch (e) {
                console.error('Error during change stream closure:', e);
              }
            }
          }
        }

        return eventGenerator();
      } catch (error) {
        console.error(chalk.red('SSE setup error:'), error);
        throw new Error(
          `Failed to initialize event stream: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
    {
      params: QueryParams,
      detail: {
        tags: ['query'],
        description:
          'Subscribe to real-time updates for MongoDB queries using Server-Sent Events (SSE)',
        summary: 'Stream query results',
        parameters: [
          {
            name: 'collectionName',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Collection to watch, use "$all" to watch all collections',
          },
          {
            name: 'base64Query',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: 'Base64-encoded MongoDB query (same format as /q endpoint)',
          },
        ],
        responses: {
          200: {
            description: 'Server-Sent Events stream of query results',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      description: 'Event type (collection name or "open")',
                      example: 'message',
                    },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        description: 'BMAP transaction object',
                      },
                      description: 'Array of matching documents',
                    },
                  },
                },
                example: [
                  'data: {"type":"open","data":[]}\n\n',
                  'data: {"type":"message","data":[{"tx":{"h":"..."},"blk":{"i":123,"t":456},"MAP":[...]}]}\n\n',
                  ':heartbeat\n\n',
                ],
              },
            },
          },
        },
      },
    }
  )

  .get('/query/:collectionName', ({ params }) => {
    const collectionName = params.collectionName;
    const q = { q: { find: { 'MAP.type': collectionName } } };
    const code = JSON.stringify(q, null, 2);

    return new Response(explorerTemplate('BMAP', code), {
      headers: { 'Content-Type': 'text/html' },
    });
  })

  .get('/query/:collectionName/:base64Query', async ({ params }) => {
    const { base64Query: b64 } = params;
    const code = Buffer.from(b64, 'base64').toString();

    return new Response(explorerTemplate('BMAP', code), {
      headers: { 'Content-Type': 'text/html' },
    });
  })

  .get(
    '/q/:collectionName/:base64Query',
    async ({ params }) => {
      const { collectionName, base64Query: b64 } = params;
      console.log(chalk.magenta('BMAP API'), chalk.cyan('query', collectionName));

      const dbo = await getDbo();
      const code = Buffer.from(b64, 'base64').toString();
      const j = JSON.parse(code);

      if (j.q.aggregate) {
        try {
          const pipeline = j.q.aggregate;
          if (j.q.sort) {
            pipeline.push({ $sort: j.q.sort });
          }
          if (j.q.limit) {
            pipeline.push({ $limit: j.q.limit });
          }

          const c = await dbo
            .collection(collectionName)
            .aggregate(pipeline, {
              allowDiskUse: true,
              cursor: { batchSize: 1000 },
            })
            .toArray();

          const signers = await resolveSigners(c as BmapTx[]);
          return { [collectionName]: c, signers };
        } catch (e) {
          console.log(e);
          throw new Error(String(e));
        }
      }

      try {
        const c = await dbo
          .collection(collectionName)
          .find(j.q.find)
          .sort(j.q.sort || { _id: -1 })
          .limit(j.q.limit ? j.q.limit : 10)
          .project(j.q.project || { in: 0, out: 0 })
          .toArray();
        const signers = await resolveSigners(c as BmapTx[]);
        console.log({ signers });
        return { [collectionName]: c, signers };
      } catch (e) {
        console.log(e);
        throw new Error(String(e));
      }
    },
    {
      params: QueryParams,
      detail: {
        tags: ['query'],
        description: 'Execute MongoDB queries with text search support',
        summary: 'Query MongoDB collections',
        responses: {
          200: {
            description: 'Query results with resolved signers',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    collectionName: {
                      type: 'array',
                      items: { type: 'object' },
                    },
                    signers: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          idKey: { type: 'string' },
                          rootAddress: { type: 'string' },
                          currentAddress: { type: 'string' },
                          addresses: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                address: { type: 'string' },
                                txId: { type: 'string' },
                                block: { type: 'number' },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
  )

  .post(
    '/ingest',
    async ({ body }: { body: IngestRequest }) => {
      const { rawTx } = body;
      console.log('Received ingest request with rawTx length:', rawTx.length);

      try {
        const tx = await processTransaction({ transaction: rawTx });
        if (!tx) throw new Error('No result returned');

        console.log('Transaction processed successfully:', tx.tx?.h);
        return tx;
      } catch (error) {
        console.error('Error processing transaction:', error);
        throw new Error(`Transaction processing failed: ${error}`);
      }
    },
    {
      body: IngestBody,
      detail: {
        tags: ['transactions'],
        description: 'Process and store a raw Bitcoin transaction',
        summary: 'Ingest transaction',
        responses: {
          200: {
            description: 'Transaction processed successfully',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    tx: {
                      type: 'object',
                      properties: {
                        h: { type: 'string', description: 'Transaction hash' },
                      },
                    },
                    blk: {
                      type: 'object',
                      properties: {
                        i: { type: 'number', description: 'Block height' },
                        t: { type: 'number', description: 'Block timestamp' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
  )

  .get(
    '/tx/:tx/:format?',
    async ({ params }) => {
      const { tx: txid, format } = params;
      if (!txid) throw new Error('Missing txid');

      try {
        // Special formats that don't need processing
        if (format === 'raw') return rawTxFromTxid(txid);
        if (format === 'json') return jsonFromTxid(txid);

        // Check Redis cache first
        const cacheKey = `tx:${txid}`;
        const cached = await readFromRedis<CacheValue>(cacheKey);
        let decoded: BmapTx;

        if (cached?.type === 'tx' && cached.value) {
          console.log('Cache hit for tx:', txid);
          decoded = cached.value;
        } else {
          console.log('Cache miss for tx:', txid);

          // Check MongoDB
          const db = await getDbo();
          const collections = ['message', 'like', 'post', 'repost'];
          let dbTx: BmapTx | null = null;

          for (const collection of collections) {
            const result = await db.collection(collection).findOne({ 'tx.h': txid });
            if (result && 'tx' in result && 'out' in result) {
              dbTx = result as unknown as BmapTx;
              console.log('Found tx in MongoDB collection:', collection);
              break;
            }
          }

          if (dbTx) {
            decoded = dbTx;
          } else {
            // Process the transaction if not found
            console.log('Processing new transaction:', txid);
            const bob = await bobFromTxid(txid);
            decoded = await TransformTx(
              bob as BobTx,
              allProtocols.map((p) => p.name)
            );

            // Get block info from WhatsonChain
            const txDetails = await jsonFromTxid(txid);
            if (txDetails.blockheight && txDetails.time) {
              decoded.blk = {
                i: txDetails.blockheight,
                t: txDetails.time,
              };
            } else if (txDetails.time) {
              decoded.timestamp = txDetails.time;
            }

            // If B or MAP protocols are found, save to MongoDB
            if (decoded.B || decoded.MAP) {
              try {
                const collection = decoded.MAP?.[0]?.type || 'message';
                await db
                  .collection(collection)
                  .updateOne({ 'tx.h': txid }, { $set: decoded }, { upsert: true });
                console.log('Saved tx to MongoDB collection:', collection);
              } catch (error) {
                console.error('Error saving to MongoDB:', error);
              }
            }
          }

          // Cache the result
          await saveToRedis<CacheValue>(cacheKey, {
            type: 'tx',
            value: decoded,
          });
        }

        // Handle file format after we have the decoded tx
        if (format === 'file') {
          let vout = 0;
          if (txid.includes('_')) {
            const parts = txid.split('_');
            vout = Number.parseInt(parts[1], 10);
          }

          let dataBuf: Buffer | undefined;
          let contentType: string | undefined;
          if (decoded.ORD?.[vout]) {
            dataBuf = Buffer.from(decoded.ORD[vout]?.data, 'base64');
            contentType = decoded.ORD[vout].contentType;
          } else if (decoded.B?.[vout]) {
            dataBuf = Buffer.from(decoded.B[vout]?.content, 'base64');
            contentType = decoded.B[vout]['content-type'];
          }

          if (dataBuf && contentType) {
            return new Response(dataBuf, {
              headers: {
                'Content-Type': contentType,
                'Content-Length': String(dataBuf.length),
              },
            });
          }
          throw new Error('No data found in transaction outputs');
        }

        // Return the appropriate format
        switch (format) {
          case 'bob':
            return bobFromTxid(txid);
          case 'bmap':
            return decoded;
          default:
            if (format && decoded[format]) {
              return decoded[format];
            }
            return format?.length
              ? `Key ${format} not found in tx`
              : `<pre>${JSON.stringify(decoded, null, 2)}</pre>`;
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to process transaction: ${message}`);
      }
    },
    {
      params: TxParams,
      detail: {
        tags: ['transactions'],
        description: 'Get transaction details in various formats',
        summary: 'Get transaction',
        responses: {
          200: {
            description: 'Transaction details in requested format',
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      description: 'BMAP format',
                      properties: {
                        tx: {
                          type: 'object',
                          properties: {
                            h: { type: 'string', description: 'Transaction hash' },
                          },
                        },
                        blk: {
                          type: 'object',
                          properties: {
                            i: { type: 'number', description: 'Block height' },
                            t: { type: 'number', description: 'Block timestamp' },
                          },
                        },
                        MAP: { type: 'array', items: { type: 'object' } },
                        AIP: { type: 'array', items: { type: 'object' } },
                        B: { type: 'array', items: { type: 'object' } },
                      },
                    },
                    {
                      type: 'string',
                      description: 'Raw transaction hex',
                    },
                    {
                      type: 'object',
                      description: 'BOB format',
                    },
                  ],
                },
              },
            },
          },
        },
      },
    }
  )

  .get('/', () => {
    // Serve index.html from public folder
    return new Response(Bun.file('./public/index.html'));
  })

  .get(
    '/chart-data/:name?',
    async ({ params, query }) => {
      console.log('Starting chart-data request');
      try {
        const timeframe = (query.timeframe as string) || Timeframe.Day;
        const collectionName = params.name;
        console.log('Chart data request for:', { collectionName, timeframe });

        const currentBlockHeight = await getBlockHeightFromCache();
        const [startBlock, endBlock] = getBlocksRange(currentBlockHeight, timeframe);
        console.log('Block range:', startBlock, '-', endBlock);

        let range = 1;
        switch (timeframe) {
          case Timeframe.Day:
            range = 1;
            break;
          case Timeframe.Week:
            range = 7;
            break;
          case Timeframe.Month:
            range = 30;
            break;
          case Timeframe.Year:
            range = 365;
            break;
        }

        if (!collectionName) {
          const dbo = await getDbo();
          const allCollections = await dbo.listCollections().toArray();
          const allDataPromises = allCollections.map((c) =>
            getTimeSeriesData(c.name, startBlock, endBlock, range)
          );
          const allTimeSeriesData = await Promise.all(allDataPromises);

          const globalData: Record<number, number> = {};
          for (const collectionData of allTimeSeriesData) {
            for (const { _id, count } of collectionData) {
              globalData[_id] = (globalData[_id] || 0) + count;
            }
          }

          const aggregatedData = Object.keys(globalData).map((blockHeight) => ({
            _id: Number(blockHeight),
            count: globalData[blockHeight],
          }));

          return {
            labels: aggregatedData.map((d) => d._id),
            values: aggregatedData.map((d) => d.count),
            range: [startBlock, endBlock],
          };
        }

        const timeSeriesData = await getTimeSeriesData(collectionName, startBlock, endBlock, range);
        return {
          labels: timeSeriesData.map((d) => d._id),
          values: timeSeriesData.map((d) => d.count),
          range: [startBlock, endBlock],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to generate chart data: ${message}`);
      }
    },
    {
      params: ChartParams,
      query: t.Object({
        timeframe: t.Optional(t.String()),
      }),
    }
  );

// Function to start listening after any async initialization
async function start() {
  console.log(chalk.magenta('BMAP API'), chalk.cyan('initializing machine...'));
  await client.connect();

  const port = Number(process.env.PORT) || 3055;
  const host = process.env.HOST || '127.0.0.1';

  app.listen({ port, hostname: host }, () => {
    console.log(chalk.magenta('BMAP API'), chalk.green(`listening on ${host}:${port}!`));
  });
}

start();
