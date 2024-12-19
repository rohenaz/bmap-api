import redis from 'redis'
import type { BapIdentity } from './bap.js'
import type { TimeSeriesData } from './chart.js'
import { getCurrentBlockHeight } from './db.js'
import type { ChartConfiguration } from 'chart.js'
import type { BmapTx } from 'bmapjs'

// Import interfaces from social.ts
import type {
  LikeInfo,
  ChannelInfo,
  MessageResponse,
  Reactions
} from './social.js'

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

export type ChartCacheData = {
  chartBuffer: string; // base64 encoded buffer
  config: ChartConfiguration;
}

export type CacheError = {
  type: 'error';
  error: number;
  value: null;
}

export type CacheValue = 
  | { type: 'error'; value: string }
  | { type: 'tx'; value: BmapTx }
  | { type: 'count'; value: Record<string, number>[] }
  | { type: 'signer'; value: BapIdentity }
  | { type: 'likes'; value: LikeInfo }
  | { type: 'channels'; value: ChannelInfo[] }
  | { type: 'messages'; value: MessageResponse }
  | { type: 'blockHeight'; value: number }
  | { type: 'ingest'; value: string[] }
  | { type: 'chart'; value: ChartCacheData }
  | { type: 'timeSeriesData'; value: TimeSeriesData }
  | { type: 'reactions'; value: Reactions }

export async function saveToRedis<T extends CacheValue>(
  key: string,
  value: T
): Promise<void> {
  await client.set(key, JSON.stringify(value))
}

export async function readFromRedis<T extends CacheValue | CacheError>(
  key: string
): Promise<T | CacheError> {
  const value = await client.get(key)
  return value
    ? (JSON.parse(value) as T)
    : ({ type: 'error', value: null, error: 404 } as CacheError)
}

export async function getBlockHeightFromCache(): Promise<number> {
  const currentBlockHeightKey = 'currentBlockHeight'
  const cachedValue = await readFromRedis<CacheValue>(currentBlockHeightKey)
  if (cachedValue?.type === 'blockHeight') {
    return cachedValue.value
  }
  const currentBlockHeight = await getCurrentBlockHeight()
  await saveToRedis<CacheValue>(currentBlockHeightKey, {
    type: 'blockHeight',
    value: currentBlockHeight
  })
  return currentBlockHeight
}

export async function deleteFromCache(key: string): Promise<void> {
  await client.del(key)
}

export async function getIngestCache(txid: string): Promise<string[]> {
  const cachedValue = await readFromRedis<CacheValue>(`ingest-${txid}`)
  if (cachedValue?.type === 'ingest') {
    return cachedValue.value
  }
  return []
}

export async function saveIngestCache(txid: string, ingestCache: string[]): Promise<void> {
  const ingestKey = `ingest-${txid}`
  const cachedValue = await readFromRedis<CacheValue>(ingestKey)
  if (!cachedValue || cachedValue.type !== 'ingest') {
    await saveToRedis<CacheValue>(ingestKey, { type: 'ingest', value: ingestCache })
  }
}

export async function getIngestCacheKeys(): Promise<string[]> {
  const cachedValue = await readFromRedis<CacheValue>('ingest')
  if (cachedValue?.type === 'ingest') {
    return cachedValue.value
  }
  return []
}

export async function getIngestCacheValues(): Promise<string[]> {
  const cachedValue = await readFromRedis<CacheValue>('ingest')
  if (cachedValue?.type === 'ingest') {
    return cachedValue.value
  }
  return []
}

export async function checkCache(txid: string): Promise<boolean> {
  const cachedValue = await readFromRedis<CacheValue>(`ingest-${txid}`)
  return cachedValue?.type === 'ingest' && cachedValue.value.includes(txid)
}

export async function addToCache(txid: string): Promise<void> {
  const ingestKey = `ingest-${txid}`
  const cachedValue = await readFromRedis<CacheValue>(ingestKey)
  let ingestCache = cachedValue?.type === 'ingest' ? cachedValue.value : []
  if (!ingestCache.includes(txid)) {
    ingestCache = [...ingestCache, txid]
    await saveToRedis<CacheValue>(ingestKey, { type: 'ingest', value: ingestCache })
  }
}

export async function loadCache(): Promise<string[]> {
  const cachedValue = await readFromRedis<CacheValue>('ingest')
  return cachedValue?.type === 'ingest' ? cachedValue.value : []
}

export async function countCachedItems(): Promise<number> {
  const cachedValue = await readFromRedis<CacheValue>('ingest')
  return cachedValue?.type === 'ingest' ? cachedValue.value.length : 0
}

// Type aliases for backward compatibility
export type CacheSigner = Extract<CacheValue, { type: 'signer' }>;
export type CacheCount = Extract<CacheValue, { type: 'count' }>;
export type CacheIngest = Extract<CacheValue, { type: 'ingest' }>;
export type CacheReactions = Extract<CacheValue, { type: 'reactions' }>;
export type CacheChannels = Extract<CacheValue, { type: 'channels' }>;
export type CacheMessages = Extract<CacheValue, { type: 'messages' }>;
export type CacheLikes = Extract<CacheValue, { type: 'likes' }>;
export type CacheBlockHeight = Extract<CacheValue, { type: 'blockHeight' }>;
export type CacheChart = Extract<CacheValue, { type: 'chart' }>;
export type CacheTimeSeriesData = Extract<CacheValue, { type: 'timeSeriesData' }>;

export { client }
