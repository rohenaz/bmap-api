import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import type { Transaction } from "@gorillapool/js-junglebus";
import bmapjs from "bmapjs";
import type { BmapTx } from "bmapjs";
import { parse } from "bpu-ts";
import chalk from "chalk";
import dotenv from "dotenv";
import type { ChangeStreamDocument } from "mongodb";
import { dirname } from "node:path";
import QuickChart from "quickchart-js";
import { fileURLToPath } from "node:url";
import { type BapIdentity, getBAPIdByAddress, resolveSigners } from "./bap.js";
import {
  type CacheCount,
  client,
  deleteFromCache,
  getBlockHeightFromCache,
  readFromRedis,
  saveToRedis,
} from "./cache.js";
import {
  type TimeSeriesData,
  generateChart,
  generateCollectionChart,
  generateTotalsChart,
  getBlocksRange,
  getTimeSeriesData,
  // defaultConfig, // not required here, only used internally in chart
  type ChartData
} from "./chart.js";
import { getCollectionCounts, getDbo, getState } from "./db.js";
import "./p2p.js";
import { processTransaction } from "./process.js";
import { Timeframe } from "./types.js";
import { explorerTemplate } from './src/components/explorer.js';

dotenv.config();

const { allProtocols, TransformTx } = bmapjs;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Focus on these Bitcoin schema collections for the dashboard
const bitcoinSchemaCollections = ["follow", "unfollow", "unlike", "like", "message", "repost", "friend", "post", "ord"];

type IngestBody = {
  rawTx: string;
};

const bobFromRawTx = async (rawtx: string) => {
  return await parse({
    tx: { r: rawtx },
    split: [
      { token: { op: 106 }, include: "l" },
      { token: { s: "|" } },
    ],
  });
};

const bobFromPlanariaByTxid = async (txid: string) => {
  const query = {
    v: 3,
    q: {
      find: { "tx.h": txid },
      sort: { "blk.i": -1, i: -1 },
      limit: 1,
    },
  };
  const b64 = Buffer.from(JSON.stringify(query)).toString("base64");
  const url = `https://bob.planaria.network/q/YOUR_PLANARIA_KEY/${b64}`;
  const header = { headers: { key: "YOUR_PLANARIA_API_KEY" } };
  const res = await fetch(url, header);
  const j = await res.json();
  return j.c.concat(j.u)[0];
};

const jsonFromTxid = async (txid: string) => {
  const url = `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}`;
  console.log("hitting", url);
  const res = await fetch(url);
  return await res.json();
};

const rawTxFromTxid = async (txid: string) => {
  const url = `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`;
  console.log("hitting", url);
  const res = await fetch(url);
  return await res.text();
};

const bobFromTxid = async (txid: string) => {
  const rawtx = await rawTxFromTxid(txid);
  try {
    return await bobFromRawTx(rawtx);
  } catch (e) {
    console.log("Failed to get rawtx from whatsonchain for", txid, "Falling back to BOB planaria.", e);
    return await bobFromPlanariaByTxid(txid);
  }
};

const app = new Elysia()
  .use(cors())
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

  app.get("/s/:collectionName?/:base64Query", async ({ params, set }) => {
    const { collectionName, base64Query: b64 } = params;
    set.headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
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

    const target = collectionName === "$all" ? db : db.collection(collectionName);
    const changeStream = target.watch(pipeline, { fullDocument: "updateLookup" });

    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: "open", data: [] })}\n\n`);

        changeStream.on("change", (next: ChangeStreamDocument<BmapTx>) => {
          if (next.operationType === "insert") {
            console.log(chalk.blue("New insert event"), next.fullDocument.tx?.h);
            controller.enqueue(
              `data: ${JSON.stringify({ type: collectionName, data: [next.fullDocument] })}\n\n`
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
      console.time("getBlockHeightFromCache");

      const timeframe = (query.timeframe as string) || Timeframe.Day;
      const currentBlockHeight = await getBlockHeightFromCache();
      const [startBlock, endBlock] = getBlocksRange(currentBlockHeight, timeframe);

      console.log("Block range:", startBlock, "-", endBlock);
      console.timeEnd("getBlockHeightFromCache");

      console.log("Bitcoin schema collections:", bitcoinSchemaCollections);

      let gridItemsHtml = "";
      for (const collection of bitcoinSchemaCollections) {
        const count = counts[collection] || 0;
        if (count === 0) {
          // No data
          gridItemsHtml += `<div class="p-4 bg-zinc-800 rounded shadow-md">
            <div class="font-semibold mb-2">${collection}</div>
            <div class="text-gray-400 text-sm">No data</div>
          </div>`;
          continue;
        }

        const timeSeriesKey = `${collection}-${startBlock}-${endBlock}`;
        const timeSeriesResult = await readFromRedis(timeSeriesKey);
        let timeSeriesData: TimeSeriesData | undefined;

        if (timeSeriesResult && timeSeriesResult.type === 'timeSeriesData') {
          timeSeriesData = timeSeriesResult.value;
        } else {
          console.log("Fetching time series data for", collection);
          timeSeriesData = await getTimeSeriesData(collection, startBlock, endBlock);
          await saveToRedis(timeSeriesKey, { type: "timeSeriesData", value: timeSeriesData });
        }

        const chart = generateChart(timeSeriesData, false);
        const chartUrl = chart.getUrl();
        console.log(`Chart for ${collection}: ${chartUrl}`);

        gridItemsHtml += `<div class="p-4 bg-zinc-800 rounded shadow-md">
          <div class="font-semibold mb-2">${collection}</div>
          <img src="${chartUrl}" class="mb-2" alt="Chart for ${collection}" width="300" />
          <div class="text-sm text-gray-200">Count: ${count}</div>
        </div>`;
      }

      const html = `<h3 class="mb-4">Bitcoin Schema Types</h3>
        <div class="grid grid-cols-4 gap-8 mb-8">
          ${gridItemsHtml}
        </div>`;

      console.timeEnd("Total Execution Time");
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    } catch (error: any) {
      console.error("An error occurred in htmx-collections:", error);
      return new Response(`<div class="text-red-500">Error loading collections: ${error.message}</div>`, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
  });

  app.get("/htmx-chart/:name?", async ({ params, query }) => {
    console.log("Starting htmx-chart request");
    try {
      const timeframe = (query.timeframe as string) || Timeframe.Day;
      const collectionName = params.name;
      console.log("Chart request for:", { collectionName, timeframe });

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

      const chartKey = `${collectionName}-${startBlock}-${endBlock}-${range}`;
      console.log("Checking cache for chart:", chartKey);

      const stored = await readFromRedis(chartKey);

      let chartData: ChartData;

      if (stored && stored.type === 'chart' && stored.value?.config) {
        chartData = stored.value;
      } else {
        console.log("Fetching chart without cache", { collectionName });
        const { chart, chartData: newChartData } = collectionName
          ? await generateTotalsChart(collectionName, startBlock, endBlock, range)
          : await generateCollectionChart(undefined, startBlock, endBlock, range);

        chartData = newChartData;
        await saveToRedis(chartKey, { type: "chart", value: chartData });
      }

      const chart = new QuickChart()
        .setConfig(chartData.config)
        .setBackgroundColor('transparent')
        .setWidth(chartData.width)
        .setHeight(chartData.height);
      const chartUrl = chart.getUrl();
      console.log("htmx-chart generated URL:", chartUrl);

      return new Response(
        `<img src='${chartUrl}' alt='Transaction${collectionName ? `s for ${collectionName}` : " totals"}' class='mt-2 mb-2' width="1280" height="300" />`,
        {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public, max-age=3600'
          },
        }
      );
    } catch (error: any) {
      console.error("Error in htmx-chart:", error);
      return new Response(
        `<div class="text-red-500">Error generating chart: ${error.message}</div>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    }
  });

  app.get("/query/:collectionName", ({ params }) => {
    const collectionName = params.collectionName;
    const q = { q: { find: { "MAP.type": collectionName } } };
    const code = JSON.stringify(q, null, 2);

    return new Response(explorerTemplate("BMAP", code), {
      headers: { 'Content-Type': 'text/html' },
    });
  });

  app.get("/query/:collectionName/:base64Query", async ({ params }) => {
    const { collectionName, base64Query: b64 } = params;
    const code = Buffer.from(b64, "base64").toString();

    return new Response(explorerTemplate("BMAP", code), {
      headers: { 'Content-Type': 'text/html' },
    });
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

  app.get("/tx/:tx/:format?", async ({ params }) => {
    const { tx, format } = params;
    if (!tx) throw new Error("Missing txid");

    try {
      if (format === "raw") {
        return await rawTxFromTxid(tx);
      }
      if (format === "json") {
        return await jsonFromTxid(tx);
      }
      if (format === "file") {
        let txid = tx;
        let vout = 0;
        if (tx.includes("_")) {
          const parts = tx.split("_");
          txid = parts[0];
          vout = Number.parseInt(parts[1]);
        }

        const bob = await bobFromTxid(txid);
        const decoded = await TransformTx(
          bob,
          allProtocols.map((p) => p.name),
        );

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
              "Content-Length": String(dataBuf.length),
            },
          });
        }
        throw new Error("No data found");
      }

      const bob = await bobFromTxid(tx);
      const decoded = await TransformTx(bob, allProtocols.map((p) => p.name));

      switch (format) {
        case "bob":
          return bob;
        case "bmap":
          return decoded;
        default:
          if (format && decoded[format]) return decoded[format];
          return format?.length
            ? `Key ${format} not found in tx`
            : `<pre>${JSON.stringify(decoded, undefined, 2)}</pre>`;
      }
    } catch (e: any) {
      throw new Error(`Failed to process tx: ${e}`);
    }
  });

  app.get("/", () => {
    return new Response(Bun.file('./public/index.html'));
  });

  app.listen({ port, hostname: host }, () => {
    console.log(
      chalk.magenta("BMAP API"),
      chalk.green(`listening on ${host}:${port}!`),
    );
  });
};

start();
