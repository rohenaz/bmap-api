import QuickChart from 'quickchart-js'
import redis from 'redis'
import { BapIdentity } from './bap.js'
import { TimeSeriesData } from './chart.js'
import { getCurrentBlockHeight } from './db.js'

// Redis client setup
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
  // await loadCache()
})

// Listen to error events on the Redis client
client.on('error', (err) => {
  console.error('Redis error:', err)
})

interface CacheBlockHeight {
  type: 'blockHeight'
  value: number
}

interface CacheChart {
  type: 'chart'
  value: QuickChart
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

export type CacheValue =
  | CacheBlockHeight
  | CacheChart
  | CacheCount
  | CacheTimeSeriesData
  | CacheIngest
  | CacheSigner
  | CacheError

interface CacheError {
  type: 'error'
  error: number
  value: null
}

// Function to serialize and save to Redis
async function saveToRedis<T extends CacheValue>(
  key: string,
  value: T
): Promise<void> {
  await client.set(key, JSON.stringify(value))
}

// Function to read and deserialize from Redis
async function readFromRedis<T extends CacheValue | CacheError>(
  key: string
): Promise<T | null> {
  const value = await client.get(key)
  return value
    ? (JSON.parse(value) as T)
    : ({ type: 'error', value: null, error: 404 } as T)
}

// Shared utility function to get block height
async function getBlockHeightFromCache(): Promise<number> {
  let cachedValue = await readFromRedis<CacheBlockHeight>('currentBlockHeight')
  if (!cachedValue) {
    const currentBlockHeight = await getCurrentBlockHeight()
    await saveToRedis('currentBlockHeight', {
      type: 'blockHeight',
      value: currentBlockHeight,
    })
    return currentBlockHeight
  } else {
    console.info('Using cached block height')
    return cachedValue.value
  }
}

// Check if a transaction ID was ingested
async function wasIngested(txid: string): Promise<boolean> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  return cachedValue ? cachedValue.value.includes(txid) : false
}

// Cache a new transaction ID
async function cacheIngestedTxid(txid: string): Promise<void> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  let ingestCache = cachedValue ? cachedValue.value : []
  if (!ingestCache.includes(txid)) {
    ingestCache = [...ingestCache, txid]
    await saveToRedis('ingest', { type: 'ingest', value: ingestCache })
  }
}

// Function to check if a txid is cached
async function checkCache(txid: string): Promise<boolean> {
  return wasIngested(txid) // This uses the same functionality as wasIngested
}

// Function to add a new txid to the cache
async function addToCache(txid: string): Promise<void> {
  await cacheIngestedTxid(txid) // Reuses cacheIngestedTxid to maintain the list of txids
}

// Function to load all cached txids from Redis
async function loadCache(): Promise<string[]> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  return cachedValue ? cachedValue.value : []
}

// Function to count items in Redis cache
async function countCachedItems(): Promise<number> {
  const cachedValue = await readFromRedis<CacheIngest>('ingest')
  return cachedValue ? cachedValue.value.length : 0
}

// Additional helper function to delete a key from Redis
async function deleteFromCache(key: string): Promise<void> {
  await client.del(key)
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
