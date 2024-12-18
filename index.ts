import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import type { Transaction } from "@gorillapool/js-junglebus";
import bmapjs from "bmapjs";
import type { BmapTx } from "bmapjs";
import { parse } from "bpu-ts";
import chalk from "chalk";
import dotenv from "dotenv";
import type { ChangeStreamDocument, Sort, Document, SortDirection } from "mongodb";
import { fileURLToPath } from "node:url";
import { type BapIdentity, getBAPIdByAddress, resolveSigners } from "./bap.js";
import { registerSocialRoutes } from './social.js';
import {
  type CacheCount,
  client,
  deleteFromCache,
  getBlockHeightFromCache,
  readFromRedis,
  saveToRedis,
} from "./cache.js";
import {
  getBlocksRange,
  getTimeSeriesData,
} from "./chart.js";
import { getCollectionCounts, getDbo, getState } from "./db.js";
import "./p2p.js";
import { processTransaction } from "./process.js";
import { Timeframe } from "./types.js";
import { explorerTemplate } from './src/components/explorer.js';

dotenv.config();

const { allProtocols, TransformTx } = bmapjs;
const __filename = fileURLToPath(import.meta.url);

// Focus on these Bitcoin schema collections for the dashboard
const bitcoinSchemaCollections = ["follow", "unfollow", "unlike", "like", "message", "repost", "friend", "post", "ord"];

type IngestBody = {
  rawTx: string;
};

const bobFromRawTx = async (rawtx: string) => {
  try {
    const result = await parse({
      tx: { r: rawtx },
      split: [
        { token: { op: 106 }, include: "l" },
        { token: { s: "|" } },
      ],
    });
    
    if (!result) {
      throw new Error("No result from parsing transaction");
    }
    
    return result;
  } catch (error) {
    console.error("Error parsing raw transaction:", error);
    throw new Error(`Failed to parse transaction: ${error instanceof Error ? error.message : String(error)}`);
  }
};


const jsonFromTxid = async (txid: string) => {
  try {
    const url = `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`;
    console.log("Fetching from WoC:", url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WhatsonChain request failed: ${res.status} ${res.statusText}`);
    }
    return await res.json();
  } catch (error) {
    console.error("Error fetching from WhatsonChain:", error);
    throw new Error(`Failed to fetch from WhatsonChain: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const rawTxFromTxid = async (txid: string) => {
  try {
    const url = `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`;
    console.log("Fetching raw tx from WoC:", url);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WhatsonChain request failed: ${res.status} ${res.statusText}`);
    }
    const text = await res.text();
    if (!text) {
      throw new Error("Empty response from WhatsonChain");
    }
    return text;
  } catch (error) {
    console.error("Error fetching raw tx from WhatsonChain:", error);
    throw new Error(`Failed to fetch raw tx: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const bobFromTxid = async (txid: string) => {
  try {
    const rawtx = await rawTxFromTxid(txid);
    try {
      return await bobFromRawTx(rawtx);
    } catch (e) {
      // console.log("Failed to get rawtx from whatsonchain for", txid, "Falling back to BOB planaria.", e);
      // return await bobFromPlanariaByTxid(txid);
      throw new Error(`Failed to get rawtx from whatsonchain for ${txid}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (error) {
    console.error("Error in bobFromTxid:", error);
    throw new Error(`Failed to process transaction: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const app = new Elysia()
  .use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  }))
  .use(staticPlugin({ assets: './public', prefix: '/' }))
  .onError(({ error }) => {
    console.error("Application error:", error);
    return new Response(
      `<div class="text-red-500">Server error: ${error.message}</div>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  })
  .derive(() => ({
    requestTimeout: 30000,
  }));

const start = async () => {
  console.log(chalk.magenta("BMAP API"), chalk.cyan("initializing machine..."));
  await client.connect();

  const port = Number(process.env.PORT) || 3055;
  const host = process.env.HOST || "127.0.0.1";

  // Register social routes
  registerSocialRoutes(app);

  app.get("/s/:collectionName?/:base64Query", async ({ params, set }) => {
    const { collectionName, base64Query: b64 } = params;
    set.headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    };

    const json = Buffer.from(b64, "base64").toString();
    const db = await getDbo();

    console.log(chalk.blue("New change stream subscription on", collectionName));
    const query = JSON.parse(json);

    const pipeline = [{ $match: { operationType: "insert" } }];
    const keys = Object.keys(query.q.find || {});
    for (const k of keys) {
      pipeline[0].$match[`fullDocument.${k}`] = query.q.find[k];
    }

    let changeStream;
    if (collectionName === "$all") {
      // Watch the entire database
      changeStream = db.watch(pipeline, { fullDocument: "updateLookup" });
    } else {
      // Watch a specific collection
      const target = db.collection(collectionName);
      changeStream = target.watch(pipeline, { fullDocument: "updateLookup" });
    }

    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: "open", data: [] })}\n\n`);

        changeStream.on("change", (next: ChangeStreamDocument<BmapTx>) => {
          if (next.operationType === "insert") {
            console.log(chalk.blue("New insert event"), next.fullDocument.tx?.h);
            const eventType = collectionName === "$all" ? next.ns.coll : collectionName;
            controller.enqueue(
              `data: ${JSON.stringify({ type: eventType, data: [next.fullDocument] })}\n\n`
            );
          }
        });

        changeStream.on("error", (e) => {
          console.log(chalk.blue("Changestream error - closing SSE"), e);
          changeStream.close();
          controller.close();
        });

        const heartbeat = setInterval(() => {
          controller.enqueue(":heartbeat\n\n");
        }, 30000);

        return () => {
          clearInterval(heartbeat);
          changeStream.close();
        };
      }
    });
  });

  app.get("/htmx-state", async () => {
    const state = await getState();
    const crawlHeight = state.height;

    // get latest block from whatsonchain
    const url = "https://api.whatsonchain.com/v1/bsv/main/chain/info";
    const resp = await fetch(url);
    const json = await resp.json();
    const latestHeight = json.blocks;

    const currentBlockHeight = await getBlockHeightFromCache();
    if (latestHeight > currentBlockHeight) {
      await deleteFromCache("currentBlockHeight");
    }

    const startHeight = 574287;
    const pctComplete = `${Math.floor(((crawlHeight - startHeight) * 100) / (latestHeight - startHeight))}%`;

    return `<div class="flex flex-col">
			<div class="text-gray-500">Sync Progress (${pctComplete})</div>
			<div class="text-lg font-semibold">${crawlHeight} / ${latestHeight}</div>
		</div>`;
  });

  // Only display known Bitcoin schema collections in htmx-collections
  app.get("/htmx-collections", async ({ query }) => {
    console.time("Total Execution Time");
    console.log("Starting htmx-collections request");

    try {
      console.time("getCollectionCounts");
      const timestamp = Math.floor(Date.now() / 1000) - 86400;
      const countsKey = `counts-${timestamp}`;
      const countsResult = await readFromRedis(countsKey);
      let counts: Record<string, number>[] = [];

      if (countsResult && countsResult.type === 'count') {
        counts = countsResult.value;
      } else {
        counts = await getCollectionCounts(timestamp);
        await saveToRedis(countsKey, { type: "count", value: counts } as CacheCount);
      }

      console.timeEnd("getCollectionCounts");

      let gridItemsHtml = "";
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

      console.timeEnd("Total Execution Time");
      return new Response(html, { 
        headers: { 'Content-Type': 'text/html' }
      });
    } catch (error: unknown) {
      console.error("An error occurred in htmx-collections:", error);
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        `<div class="text-red-500">Error loading collections: ${message}</div>`, 
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
  });

  app.get("/query/:collectionName", ({ params }) => {
    const collectionName = params.collectionName;
    const q = { q: { find: { "MAP.type": collectionName } } };
    const code = JSON.stringify(q, null, 2);

    return new Response(explorerTemplate("BMAP", code), {
      headers: { 'Content-Type': 'text/html' }
    });
  });

  app.get("/query/:collectionName/:base64Query", async ({ params }) => {
    const { collectionName, base64Query: b64 } = params;
    const code = Buffer.from(b64, "base64").toString();

    return new Response(explorerTemplate("BMAP", code), {
      headers: { 'Content-Type': 'text/html' }
    });
  });

  app.get("/q/:collectionName/:base64Query", async ({ params }) => {
    console.log("Starting query execution");
    const { collectionName, base64Query } = params;
    
    try {
      // Decode and parse query
      const code = Buffer.from(base64Query, "base64").toString();
      console.log("Decoded query:", code);
      
      type SortObject = { [key: string]: SortDirection };
      
      let q: { q: { 
        find: Record<string, unknown>; 
        limit?: number; 
        sort?: SortObject;
        skip?: number; 
        project?: Document 
      }};

      try {
        q = JSON.parse(code);
      } catch (e) {
        console.error("JSON parse error:", e);
        return new Response(JSON.stringify({ error: "Invalid JSON query" }), {
          status: 400,
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-cache"
          }
        });
      }

      // Validate query structure
      if (!q.q || typeof q.q !== 'object') {
        return new Response(JSON.stringify({ error: "Invalid query structure. Expected {q: {find: {...}}}" }), {
          status: 400,
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-cache"
          }
        });
      }

      const db = await getDbo();
      
      // Extract query parameters with defaults
      const query = q.q.find || {};
      const limit = q.q.limit || 100;
      const defaultSort: SortObject = { "blk.i": -1 };
      const sortParam = q.q.sort || defaultSort;
      
      // Convert sort object to MongoDB sort format
      const sortEntries = Object.entries(sortParam);
      const sort: Sort = sortEntries.length === 1 ? [sortEntries[0][0], sortEntries[0][1]] : sortEntries;
      
      const skip = q.q.skip || 0;
      const projection = q.q.project || null;

      console.log("Executing query:", {
        collection: collectionName,
        query,
        limit,
        sort,
        skip,
        projection
      });

      // Execute query with all parameters
      const results = await db.collection(collectionName)
        .find(query)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .project(projection)
        .toArray();

      console.log(`Query returned ${results.length} results`);

      // Return results with caching headers only
      return new Response(JSON.stringify({ [collectionName]: results }), {
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60"
        }
      });
    } catch (error: unknown) {
      console.error("Query execution error:", error);
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ 
        error: message,
        details: "An error occurred while executing the query"
      }), {
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }
  });

  app.post("/ingest", async ({ body }) => {
    const typedBody = body as IngestBody;
    console.log("ingest", typedBody.rawTx);

    if (typedBody.rawTx) {
      try {
        const tx = await processTransaction({ transaction: typedBody.rawTx } as Partial<Transaction>);
        if (!tx) throw new Error("Transaction processing failed");
        return tx;
      } catch (e) {
        console.log(e);
        throw new Error(String(e));
      }
    }
    throw new Error("Missing rawTx in request body");
  });

  // Add new cache type at the top with other types
  type CacheTx = {
    type: 'tx';
    value: BmapTx;
  }

  app.get("/tx/:tx/:format?", async ({ params }) => {
    const { tx: txid, format } = params;
    if (!txid) {
      return new Response(JSON.stringify({
        error: "Missing txid",
        details: "Transaction ID is required"
      }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    try {
      // Special formats that don't need processing
      if (format === "raw") {
        const rawTx = await rawTxFromTxid(txid);
        return new Response(rawTx, {
          headers: { "Content-Type": "text/plain" }
        });
      }
      
      if (format === "json") {
        const jsonTx = await jsonFromTxid(txid);
        return new Response(JSON.stringify(jsonTx, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      }

      // Check Redis cache first
      const cacheKey = `tx:${txid}`;
      const cached = await readFromRedis<CacheTx>(cacheKey);
      let decoded: BmapTx;

      if (cached?.type === 'tx') {
        console.log('Cache hit for tx:', txid);
        decoded = cached.value;
      } else {
        console.log('Cache miss for tx:', txid);
        
        // Check MongoDB
        const db = await getDbo();
        const collections = ["message", "like", "post", "repost"]; // Add other relevant collections
        let dbTx: BmapTx | null = null;

        for (const collection of collections) {
          const result = await db.collection(collection).findOne({ "tx.h": txid });
          if (result) {
            dbTx = result as BmapTx;
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
          decoded = await TransformTx(bob, allProtocols.map((p) => p.name)) as BmapTx;

          // Get block info from WhatsonChain
          const txDetails = await jsonFromTxid(txid);
          if (txDetails.blockheight && txDetails.time) {
            decoded.blk = {
              i: txDetails.blockheight,
              t: txDetails.time
            };
          } else if (txDetails.time) {
            decoded.timestamp = txDetails.time;
          }

          // If B or MAP protocols are found, save to MongoDB
          if (decoded.B || decoded.MAP) {
            try {
              const collection = decoded.MAP?.[0]?.type || 'message';
              await db.collection(collection).updateOne(
                { "tx.h": txid },
                { $set: decoded },
                { upsert: true }
              );
              console.log('Saved tx to MongoDB collection:', collection);
            } catch (error) {
              console.error('Error saving to MongoDB:', error);
            }
          }
        }

        // Cache the result
        await saveToRedis<CacheTx>(cacheKey, {
          type: 'tx',
          value: decoded
        });
      }

      // Handle file format after we have the decoded tx
      if (format === "file") {
        let vout = 0;
        if (txid.includes("_")) {
          const parts = txid.split("_");
          vout = Number.parseInt(parts[1], 10);
        }

        let dataBuf: Buffer | undefined;
        let contentType: string | undefined;
        if (decoded.ORD?.[vout]) {
          dataBuf = Buffer.from(decoded.ORD[vout]?.data, "base64");
          contentType = decoded.ORD[vout].contentType;
        } else if (decoded.B?.[vout]) {
          dataBuf = Buffer.from(decoded.B[vout]?.content, "base64");
          contentType = decoded.B[vout]["content-type"];
        }

        if (dataBuf && contentType) {
          return new Response(dataBuf, {
            headers: {
              "Content-Type": contentType,
              "Content-Length": String(dataBuf.length)
            }
          });
        }
        throw new Error("No data found in transaction outputs");
      }

      // Return the appropriate format
      switch (format) {
        case "bob":
          const bob = await bobFromTxid(txid);
          return new Response(JSON.stringify(bob, null, 2), {
            headers: { "Content-Type": "application/json" }
          });
        case "bmap":
          return new Response(JSON.stringify(decoded, null, 2), {
            headers: { "Content-Type": "application/json" }
          });
        default:
          if (format && decoded[format]) {
            return new Response(JSON.stringify(decoded[format], null, 2), {
              headers: { "Content-Type": "application/json" }
            });
          }
          return new Response(format?.length
            ? `Key ${format} not found in tx`
            : `<pre>${JSON.stringify(decoded, null, 2)}</pre>`, {
              headers: { "Content-Type": format?.length ? "text/plain" : "text/html" }
            });
      }
    } catch (error: unknown) {
      console.error("Error processing tx request:", error);
      const message = error instanceof Error ? error.message : String(error);
      
      return new Response(JSON.stringify({
        error: "Failed to process transaction",
        details: message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    }
  });

  app.get("/", () => {
    return new Response(Bun.file('./public/index.html'));
  });

  app.get("/chart-data/:name?", async ({ params, query }) => {
    console.log("Starting chart-data request");
    try {
      const timeframe = (query.timeframe as string) || Timeframe.Day;
      const collectionName = params.name;
      console.log("Chart data request for:", { collectionName, timeframe });

      const currentBlockHeight = await getBlockHeightFromCache();
      const [startBlock, endBlock] = getBlocksRange(currentBlockHeight, timeframe);
      console.log("Block range:", startBlock, "-", endBlock);

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

        return new Response(JSON.stringify({
          labels: aggregatedData.map(d => d._id),
          values: aggregatedData.map(d => d.count),
          range: [startBlock, endBlock]
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600'
          }
        });
      }

      const timeSeriesData = await getTimeSeriesData(collectionName, startBlock, endBlock, range);
      return new Response(JSON.stringify({
        labels: timeSeriesData.map(d => d._id),
        values: timeSeriesData.map(d => d.count),
        range: [startBlock, endBlock]
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600'
        }
      });
    } catch (error: unknown) {
      console.error("Error in chart-data:", error);
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  function tryParseJSON(str: string): unknown {
    if (typeof str !== 'string') return str;
    try {
      return JSON.parse(str);
    } catch (e) {
      return str; // fallback to original string if not valid JSON
    }
  }

  function ensureJSONString(value: unknown): string {
    if (typeof value === 'string') {
      try {
        // Check if it's already a valid JSON string
        JSON.parse(value);
        return value;
      } catch {
        // If not valid JSON, stringify it
        return JSON.stringify(value);
      }
    }
    // If not a string, stringify it
    return JSON.stringify(value);
  }

  function ensureIdentityString(identity: unknown): string {
    if (typeof identity === 'string') {
      try {
        // Check if it's already a valid JSON string
        JSON.parse(identity);
        return identity;
      } catch {
        // If not valid JSON, stringify it
        return JSON.stringify({ alternateName: identity });
      }
    }
    // If it's an object or anything else, stringify it
    return JSON.stringify(identity);
  }

  
  app.get("/identities", async () => {
    try {
      if (!client.isReady) {
        console.error("Redis client is not ready");
        return new Response(JSON.stringify([]), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }

      const idCacheKey = "signer-*";
      console.log("Searching for Redis keys with pattern:", idCacheKey);
      const keys = await client.keys(idCacheKey);
      console.log("Found Redis keys:", keys);

      if (!keys.length) {
        console.log("No identity keys found in Redis");
        return new Response(JSON.stringify([]), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-cache"
          }
        });
      }

      const identities = await Promise.all(
        keys.map(async (k) => {
          try {
            console.log("Fetching key:", k);
            const cachedValue = await readFromRedis(k);
            console.log("Cached value type:", cachedValue?.type);
            console.log("Cached value exists:", !!cachedValue?.value);
            
            if (cachedValue && cachedValue.type === 'signer' && cachedValue.value) {
              const identity = cachedValue.value;

              // Parse the identity into an object
              const identityObj = parseIdentity(identity.identity);

              return {
                idKey: identity.idKey,
                rootAddress: identity.rootAddress,
                currentAddress: identity.currentAddress,
                addresses: identity.addresses?.map((addr: any) => ({
                  address: addr.address,
                  txId: addr.txId,
                  block: addr.block
                })) || [],
                identity: identityObj,
                identityTxId: identity.identityTxId,
                block: identity.block || 0,
                timestamp: typeof identity.timestamp === 'number' ? identity.timestamp : Math.floor(identity.timestamp / 1000),
                valid: identity.valid ?? true
              };
            }
            console.log("Invalid or missing value for key:", k);
            return null;
          } catch (error) {
            console.error(`Error fetching key ${k}:`, error);
            return null;
          }
        })
      );

      const filteredIdentities = identities.filter((id) => id !== null);
      console.log("Total identities found:", keys.length);
      console.log("Valid identities after filtering:", filteredIdentities.length);

      return new Response(JSON.stringify(filteredIdentities), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache"
        }
      });
    } catch (e) {
      console.error("Failed to get identities:", e);
      return new Response(JSON.stringify([]), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  
  app.listen({ port, hostname: host }, () => {
    console.log(
      chalk.magenta("BMAP API"),
      chalk.green(`listening on ${host}:${port}!`),
    );
  });
};



start();



function parseIdentity(identityValue: unknown): Record<string, unknown> {
  // If identity is already an object, return it as is
  if (typeof identityValue === 'object' && identityValue !== null) {
    return identityValue as Record<string, unknown>;
  }
  
  // If it's a string, try to parse as JSON
  if (typeof identityValue === 'string') {
    // Strip leading/trailing quotes if present
    let trimmed = identityValue.trim();
    if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
      trimmed = trimmed.slice(1, -1);
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      } else {
        // It's valid JSON but not an object, wrap it in an object
        return { alternateName: parsed };
      }
    } catch {
      // Not valid JSON, just treat it as a plain string in an object
      return { alternateName: trimmed };
    }
  }

  // Fallback: wrap whatever it is in an object
  return { alternateName: String(identityValue) };
}
