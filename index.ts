import { fileURLToPath } from 'node:url';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { swagger } from '@elysiajs/swagger';
import type { Static } from '@sinclair/typebox';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { Elysia, NotFoundError, t } from 'elysia';
import type { ChangeStreamDocument, Document, Sort, SortDirection } from 'mongodb';

import type { Transaction } from '@gorillapool/js-junglebus';
import type { BmapTx, BobTx } from 'bmapjs';
import bmapjs from 'bmapjs';
import { parse } from 'bpu-ts';

import { registerSocialRoutes } from './social.js';
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
import { explorerTemplate } from './src/components/explorer.js';
import { Timeframe } from './types.js';

import type { ChangeStream } from 'mongodb';

dotenv.config();

const { allProtocols, TransformTx } = bmapjs;
const __filename = fileURLToPath(import.meta.url);

// Focus on these Bitcoin schema collections for the dashboard
const bitcoinSchemaCollections = [
  'follow',
  'unfollow',
  'unlike',
  'like',
  'message',
  'repost',
  'friend',
  'post',
  'ord',
];

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

// Helper function to parse identity values
function parseIdentity(identityValue: unknown): Record<string, unknown> {
  // If identity is already an object, return it as is
  if (typeof identityValue === 'object' && identityValue !== null) {
    return identityValue as Record<string, unknown>;
  }

  // If it's a string, try to parse as JSON
  if (typeof identityValue === 'string') {
    let trimmed = identityValue.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      trimmed = trimmed.slice(1, -1);
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
      // It's valid JSON but not an object, wrap it in an object
      return { alternateName: parsed };
    } catch {
      // Not valid JSON, just treat it as a plain string in an object
      return { alternateName: trimmed };
    }
  }

  // Fallback: wrap whatever it is in an object
  return { alternateName: String(identityValue) };
}

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
          { name: 'transactions', description: 'Transaction related endpoints' },
          { name: 'social', description: 'Social features like friends and likes' },
          { name: 'charts', description: 'Chart generation endpoints' },
          { name: 'identities', description: 'BAP identity management' },
        ],
      },
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

  // Routes
  .get('/s/:collectionName?/:base64Query', async ({ params, set }) => {
    const { collectionName, base64Query: b64 } = params;

    set.headers = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': 'http://localhost:5173',
      'Access-Control-Allow-Credentials': 'true',
    };

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
  })

  .get('/htmx-state', async () => {
    const state = await getState();
    const crawlHeight = state.height;

    // get latest block from whatsonchain
    const url = 'https://api.whatsonchain.com/v1/bsv/main/chain/info';
    const resp = await fetch(url);
    const json = await resp.json();
    const latestHeight = json.blocks;

    const currentBlockHeight = await getBlockHeightFromCache();
    if (latestHeight > currentBlockHeight) {
      await deleteFromCache('currentBlockHeight');
    }

    const startHeight = 574287;
    const pctComplete = `${Math.floor(
      ((crawlHeight - startHeight) * 100) / (latestHeight - startHeight)
    )}%`;

    return `<div class="flex flex-col">
      <div class="text-gray-500">Sync Progress (${pctComplete})</div>
      <div class="text-lg font-semibold">${crawlHeight} / ${latestHeight}</div>
    </div>`;
  })

  .get('/htmx-collections', async () => {
    console.time('Total Execution Time');
    console.log('Starting htmx-collections request');

    try {
      console.time('getCollectionCounts');
      const timestamp = Math.floor(Date.now() / 1000) - 86400;
      const countsKey = `counts-${timestamp}`;
      const countsResult = await readFromRedis(countsKey);
      let counts: Record<string, number>[] = [];

      if (countsResult && countsResult.type === 'count') {
        counts = countsResult.value;
      } else {
        counts = await getCollectionCounts(timestamp);
        await saveToRedis(countsKey, { type: 'count', value: counts } as CacheCount);
      }
      console.timeEnd('getCollectionCounts');

      let gridItemsHtml = '';
      for (const collection of bitcoinSchemaCollections) {
        const count = counts[collection] || 0;
        const explorerUrl = `/query/${encodeURIComponent(collection)}`;

        if (count === 0) {
          gridItemsHtml += `
            <div class="chart-card">
              <a href="${explorerUrl}" class="title hover:text-blue-400 transition-colors">${collection}</a>
              <div class="text-gray-400 text-sm">No data</div>
            </div>`;
          continue;
        }

        gridItemsHtml += `
          <div class="chart-card">
            <a href="${explorerUrl}" class="title hover:text-blue-400 transition-colors">${collection}</a>
            <div class="chart-wrapper">
              <div class="small-chart-container">
                <canvas id="chart-${collection}" 
                        width="300" height="75"
                        data-collection="${collection}"
                        class="hover:opacity-80 transition-opacity"></canvas>
              </div>
            </div>
            <div class="footer">Count: ${count}</div>
          </div>`;
      }

      const html = `
        <h3 class="mb-4">Bitcoin Schema Types</h3>
        <div class="grid grid-cols-4 gap-8 mb-8">
          ${gridItemsHtml}
        </div>`;

      console.timeEnd('Total Execution Time');
      return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
      });
    } catch (error: unknown) {
      console.error('An error occurred in htmx-collections:', error);
      const message = error instanceof Error ? error.message : String(error);
      return new Response(`<div class="text-red-500">Error loading collections: ${message}</div>`, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
  })

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
      console.log('Starting query execution');
      const { collectionName, base64Query } = params;

      try {
        // Decode and parse query
        const code = Buffer.from(base64Query, 'base64').toString();
        console.log('Decoded query:', code);

        type SortObject = { [key: string]: SortDirection };

        let q: {
          q: {
            find: Record<string, unknown>;
            limit?: number;
            sort?: SortObject;
            skip?: number;
            project?: Document;
          };
        };

        try {
          q = JSON.parse(code);
        } catch (_e) {
          throw new Error('Invalid JSON query');
        }

        // Validate query structure
        if (!q.q || typeof q.q !== 'object') {
          throw new Error('Invalid query structure. Expected {q: {find: {...}}}');
        }

        const db = await getDbo();

        // Extract query parameters with defaults
        const query = q.q.find || {};
        const limit = q.q.limit || 100;
        const defaultSort: SortObject = { 'blk.i': -1 };
        const sortParam = q.q.sort || defaultSort;

        // Convert sort object to MongoDB sort format
        const sortEntries = Object.entries(sortParam);
        const sort: Sort =
          sortEntries.length === 1 ? [sortEntries[0][0], sortEntries[0][1]] : sortEntries;

        const skip = q.q.skip || 0;
        const projection = q.q.project || null;

        console.log('Executing query:', {
          collection: collectionName,
          query,
          limit,
          sort,
          skip,
          projection,
        });

        // Execute query with all parameters
        const results = await db
          .collection(collectionName)
          .find(query)
          .sort(sort)
          .skip(skip)
          .limit(limit)
          .project(projection)
          .toArray();

        console.log(`Query returned ${results.length} results`);
        return { [collectionName]: results };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to execute query: ${message}`);
      }
    },
    {
      // Route-level schema for params
      params: QueryParams,
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
          case 'bob': {
            const bob = await bobFromTxid(txid);
            return bob;
          }
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
  )

  .get('/identities', async ({ set }) => {
    try {
      console.log('=== Starting /identities request ===');

      // Check Redis connection
      console.log('Checking Redis connection...');
      if (!client.isReady) {
        console.error('Redis client is not ready');
        set.status = 503;
        return { error: 'Redis client not ready', signers: [] };
      }
      console.log('Redis client is ready');

      // Search for identity keys
      console.log('Searching for Redis keys...');
      const idCacheKey = 'signer-*';
      const keys = await client.keys(idCacheKey);
      console.log(`Found ${keys.length} Redis keys:`, keys);

      if (!keys.length) {
        console.log('No identity keys found in Redis');
        return { message: 'No identities found', signers: [] };
      }

      // Process each identity
      console.log('Processing identities...');
      const identities = await Promise.all(
        keys.map(async (k) => {
          try {
            console.log(`\nProcessing key: ${k}`);
            const cachedValue = await readFromRedis<CacheValue>(k);
            console.log('Raw cached value:', cachedValue);

            if (!cachedValue) {
              console.log(`No value found for key: ${k}`);
              return null;
            }
            if (cachedValue.type !== 'signer') {
              console.log(`Invalid type for key ${k}:`, cachedValue.type);
              return null;
            }

            const identity = cachedValue.value;
            console.log('Identity value:', identity);
            if (!identity || !identity.idKey) {
              console.log('Invalid identity structure:', identity);
              return null;
            }

            // Parse the identity into an object
            const identityObj = parseIdentity(identity.identity);
            console.log('Parsed identity object:', identityObj);

            // Return the shape that the frontend expects
            return {
              idKey: identity.idKey,
              paymail: identityObj.paymail || identity.paymail,
              displayName: identityObj.alternateName || identityObj.name || identity.idKey,
              icon: identityObj.image || identityObj.icon || identityObj.avatar,
            };
          } catch (error) {
            console.error(`Error processing key ${k}:`, error);
            return null;
          }
        })
      );

      const filteredIdentities = identities.filter(
        (id): id is NonNullable<typeof id> => id !== null
      );

      console.log('\n=== Identity Processing Summary ===');
      console.log('Total keys found:', keys.length);
      console.log('Successfully processed:', filteredIdentities.length);
      console.log('Failed/invalid:', keys.length - filteredIdentities.length);
      console.log('Final identities:', JSON.stringify(filteredIdentities, null, 2));

      return { message: 'Success', signers: filteredIdentities };
    } catch (e) {
      console.error('=== Error in /identities endpoint ===');
      console.error('Error details:', e);
      console.error('Stack trace:', e instanceof Error ? e.stack : 'No stack trace');
      set.status = 500;
      return { error: 'Failed to get identities', signers: [] };
    }
  });

// Function to start listening after any async initialization
async function start() {
  console.log(chalk.magenta('BMAP API'), chalk.cyan('initializing machine...'));
  await client.connect();

  // Register social routes (if it modifies `app` directly)
  registerSocialRoutes(app);

  const port = Number(process.env.PORT) || 3055;
  const host = process.env.HOST || '127.0.0.1';

  app.listen({ port, hostname: host }, () => {
    console.log(chalk.magenta('BMAP API'), chalk.green(`listening on ${host}:${port}!`));
  });
}

start();
