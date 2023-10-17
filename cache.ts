import QuickChart from 'quickchart-js'
import { TimeSeriesData, timeframeToBlocks } from './chart'
import { getCurrentBlockHeight } from './db'

// cache for express responses
type CacheValue =
  | { type: 'blockHeight'; value: number }
  | { type: 'chart'; value: QuickChart }
  | { type: 'count'; value: Record<string, number> }
  | { type: 'timeSeriesData'; value: TimeSeriesData }

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
  }
  return currentBlockHeight
}

// Shared utility function to get blocks range
function getBlocksRange(
  currentBlockHeight: number,
  timeframe: string
): [number, number] {
  const blocks = timeframeToBlocks(timeframe)
  const startBlock = currentBlockHeight - blocks
  const endBlock = currentBlockHeight
  return [startBlock, endBlock]
}

export { cache, getBlockHeightFromCache, getBlocksRange }
