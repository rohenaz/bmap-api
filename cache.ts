import redis from 'redis'
import type { BapIdentity } from './bap.js'
import type { TimeSeriesData } from './chart.js'
import { getCurrentBlockHeight } from './db.js'
import type { ChartData } from './chart.js'
import { ChartConfiguration } from 'chart.js'

const client = redis.createClient({
  url: process.env.REDIS_PRIVATE_URL,
})

process.on('SIGINT', () => {
  client.quit().then(() => {
    console.log('Redis client disconnected')
    process.exit(0)
  })
})

client.on('connect', async () => {
  console.log('Redis: Client connected')
})

client.on('error', (err) => {
  console.error('Redis error:', err)
})

export type CacheBlockHeight = {
  type: 'blockHeight';
  value: number;
}

export type CacheChart = {
  type: 'chart';
  value: ChartCacheData;
}

export type CacheCount = {
  type: 'count';
  value: Record<string, number>[];
}

export type CacheTimeSeriesData = {
  type: 'timeSeriesData';
  value: TimeSeriesData;
}

export type CacheIngest = {
  type: 'ingest';
  value: string[];
}

export type CacheSigner = {
  type: 'signer';
  value: BapIdentity;
}

export type CacheError = {
  type: 'error';
  error: number;
  value: null;
}

export type ChartCacheData = {
  chartBuffer: string; // base64 encoded buffer
  config: ChartConfiguration;
}

export type CacheValue = 
  | CacheBlockHeight 
  | CacheChart 
  | CacheCount 
  | CacheTimeSeriesData 
  | CacheIngest 
  | CacheSigner;

async function saveToRedis<T extends CacheValue>(
  key: string,
  value: T
): Promise<void> {
  await client.set(key, JSON.stringify(value))
}

async function readFromRedis<T extends CacheValue | CacheError>(
  key: string
): Promise<T | CacheError> {
  const value = await client.get(key)
  return value
    ? (JSON.parse(value) as T)
    : ({ type: 'error', value: null, error: 404 } as CacheError)
}

async function getBlockHeightFromCache(): Promise<number> {
  const cachedValue = await readFromRedis<CacheBlockHeight>('currentBlockHeight')
  if (cachedValue.type === 'error') {
    const currentBlockHeight = await getCurrentBlockHeight()
    const currentBlockHeightKey = `currentBlockHeight-${currentBlockHeight}`
    await saveToRedis<CacheBlockHeight>(currentBlockHeightKey, {
      type: 'blockHeight',
      value: currentBlockHeight,
    })
    return currentBlockHeight
  } else {
    console.info('Using cached block height')
    return cachedValue.value
  }
}

async function deleteFromCache(key: string): Promise<void> {
  await client.del(key)
}

async function wasIngested(txid: string): Promise<boolean> {
  const cachedValue = await readFromRedis<CacheIngest>(`ingest-${txid}`)
  return cachedValue.type === 'ingest' ? cachedValue.value.includes(txid) : false
}

async function cacheIngestedTxid(txid: string): Promise<void> {
  const ingestKey = `ingest-${txid}`
  const cachedValue = await readFromRedis<CacheIngest>(ingestKey)
  let ingestCache = cachedValue.type === 'ingest' ? cachedValue.value : []
  if (!ingestCache.includes(txid)) {
    ingestCache = [...ingestCache, txid]
    await saveToRedis<CacheIngest>(ingestKey, { type: 'ingest', value: ingestCache })
  }
}

async function checkCache(txid: string): Promise<boolean> {
  return wasIngested(txid)
}

async function addToCache(txid: string): Promise<void> {
  await cacheIngestedTxid(txid)
}

async function loadCache(): Promise<string[]> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  return cachedValue.type === 'ingest' ? cachedValue.value : []
}

async function countCachedItems(): Promise<number> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  return cachedValue.type === 'ingest' ? cachedValue.value.length : 0
}

export {
  addToCache,
  cacheIngestedTxid,
  checkCache,
  client,
  countCachedItems,
  deleteFromCache,
  getBlockHeightFromCache,
  loadCache,
  readFromRedis,
  saveToRedis,
  wasIngested,
}
