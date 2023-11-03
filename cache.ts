import _ from 'lodash'
import QuickChart from 'quickchart-js'
import { TimeSeriesData } from './chart.js'
import { getCurrentBlockHeight } from './db.js'
const { uniq } = _

// cache for express responses
type CacheValue =
  | { type: 'blockHeight'; value: number }
  | { type: 'chart'; value: QuickChart }
  | { type: 'count'; value: Record<string, number> }
  | { type: 'timeSeriesData'; value: TimeSeriesData }
  | { type: 'ingest'; value: string[] }

const cache = new Map<string, CacheValue>()

// Shared utility function to get block height
async function getBlockHeightFromCache(): Promise<number> {
  let currentBlockHeight = cache.get('currentBlockHeight')?.value as number
  if (!currentBlockHeight) {
    currentBlockHeight = await getCurrentBlockHeight()

    cache.set('currentBlockHeight', {
      type: 'blockHeight',
      value: currentBlockHeight,
    })
  } else {
    console.info('Using cached block height')
  }
  return currentBlockHeight
}

const wasIngested = (txid: string): boolean => {
  const ingest = cache.get('ingest')?.value as string[]
  if (!ingest) {
    throw new Error('Ingest cache not initialized')
  }
  return ingest.includes(txid)
}

const cacheIngestedTxid = (txid: string): void => {
  cache.set('ingest', {
    type: 'ingest',
    value: uniq([...(cache.get('ingest')?.value as string[]), txid]),
  })
}

export { cache, cacheIngestedTxid, getBlockHeightFromCache, wasIngested }
