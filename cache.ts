import redis from 'redis'
import { BapIdentity } from './bap.js'
import { TimeSeriesData } from './chart.js'
import { getCurrentBlockHeight } from './db.js'
import type { ChartData } from './chart.js'

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

interface CacheBlockHeight {
  type: 'blockHeight'
  value: number
}

interface CacheChart {
  type: 'chart'
  value: ChartData
}

export interface CacheCount {
  type: 'count'
  value: Record<string, number>[]
}

interface CacheTimeSeriesData {
  type: 'timeSeriesData'
  value: TimeSeriesData
}

interface CacheIngest {
  type: 'ingest'
  value: string[]
}

export interface CacheSigner {
  type: 'signer'
  value: BapIdentity
}

interface CacheError {
  type: 'error'
  error: number
  value: null
}

export type CacheValue =
  | CacheBlockHeight
  | CacheChart
  | CacheCount
  | CacheTimeSeriesData
  | CacheIngest
  | CacheSigner
  | CacheError

async function saveToRedis<T extends CacheValue>(
  key: string,
  value: T
): Promise<void> {
  await client.set(key, JSON.stringify(value))
}

async function readFromRedis<T extends CacheValue | CacheError>(
  key: string
): Promise<T | null> {
  const value = await client.get(key)
  return value
    ? (JSON.parse(value) as T)
    : ({ type: 'error', value: null, error: 404 } as T)
}

async function getBlockHeightFromCache(): Promise<number> {
  let cachedValue = await readFromRedis<CacheBlockHeight>('currentBlockHeight')
  if (!cachedValue.value) {
    const currentBlockHeight = await getCurrentBlockHeight()
    const currentBlockHeightKey = `currentBlockHeight-${currentBlockHeight}`
    await saveToRedis(currentBlockHeightKey, {
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
  return cachedValue?.value ? cachedValue.value.includes(txid) : false
}

async function cacheIngestedTxid(txid: string): Promise<void> {
  const ingestKey = `ingest-${txid}`
  const cachedValue = await readFromRedis<CacheIngest>(ingestKey)
  let ingestCache = cachedValue?.value ? cachedValue.value : []
  if (!ingestCache.includes(txid)) {
    ingestCache = [...ingestCache, txid]
    await saveToRedis(ingestKey, { type: 'ingest', value: ingestCache })
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
  return cachedValue?.value ? cachedValue.value : []
}

async function countCachedItems(): Promise<number> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  return cachedValue?.value ? cachedValue.value.length : 0
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
