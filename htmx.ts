import chalk from 'chalk';
import { Elysia } from 'elysia';
import { t } from 'elysia';
import { deleteFromCache, getBlockHeightFromCache } from './cache.js';
import { readFromRedis, saveToRedis } from './cache.js';
import type { CacheCount, CacheValue } from './cache.js';
import { getBlocksRange, getTimeSeriesData } from './chart.js';
import { getState } from './db.js';
import { getCollectionCounts } from './db.js';

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

export const htmxRoutes = new Elysia()
  .get(
    '/htmx-state',
    async () => {
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
    },
    {
      detail: {
        tags: ['htmx'],
        description: 'Get current blockchain sync progress for HTMX updates',
        summary: 'Get sync state',
        responses: {
          200: {
            description: 'HTML fragment showing sync progress',
            content: {
              'text/html': {
                schema: {
                  type: 'string',
                  example: `<div class="flex flex-col">
                  <div class="text-gray-500">Sync Progress (45%)</div>
                  <div class="text-lg font-semibold">123456 / 234567</div>
                </div>`,
                },
              },
            },
          },
        },
      },
    }
  )

  .get(
    '/htmx-collections',
    async () => {
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
        return new Response(
          `<div class="text-red-500">Error loading collections: ${message}</div>`,
          {
            headers: { 'Content-Type': 'text/html' },
          }
        );
      }
    },
    {
      detail: {
        tags: ['htmx'],
        description: 'Get collection statistics with charts for HTMX updates',
        summary: 'Get collection stats',
        responses: {
          200: {
            description: 'HTML fragment showing collection statistics with embedded charts',
            content: {
              'text/html': {
                schema: {
                  type: 'string',
                  example: `<div class="grid grid-cols-4 gap-8 mb-8">
                  <div class="chart-card">
                    <a href="/query/message" class="title">message</a>
                    <div class="chart-wrapper">
                      <canvas id="chart-message" width="300" height="75"></canvas>
                    </div>
                    <div class="footer">Count: 12345</div>
                  </div>
                </div>`,
                },
              },
            },
          },
          500: {
            description: 'Error message in HTML format',
            content: {
              'text/html': {
                schema: {
                  type: 'string',
                  example:
                    '<div class="text-red-500">Error loading collections: Database connection failed</div>',
                },
              },
            },
          },
        },
      },
    }
  );
