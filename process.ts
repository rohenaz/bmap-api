import { Transaction } from '@gorillapool/js-junglebus'
import { BmapTx, BobTx } from 'bmapjs/types/common'
import { parse } from 'bpu-ts'
import { saveTx } from './actions.js'
import { getBAPIdByAddress } from './bap.js'
import {
  cacheIngestedTxid,
  readFromRedis,
  saveToRedis,
  wasIngested,
} from './cache.js'

const bobFromRawTx = async (rawtx: string) => {
  return await parse({
    tx: { r: rawtx },
    split: [
      {
        token: { op: 106 },
        include: 'l',
      },
      {
        token: { s: '|' },
      },
    ],
  })
}

export async function processTransaction(ctx: Partial<Transaction>) {
  let result: Partial<BmapTx>
  if (wasIngested(ctx.id)) {
    console.log('Already ingested', ctx.id)
    return null
  }
  try {
    result = (await bobFromRawTx(ctx.transaction)) as Partial<BmapTx>

    result.blk = {
      i: ctx.block_height || 0,
      t: ctx.block_time || Math.round(new Date().getTime() / 1000),
    }

    cacheIngestedTxid(result.tx.h)
    // TODO: We should enable this field in BmapTx
    // and publish field extensions in docs
    // result.tx = {
    //   m: ctx.merkle_proof || '',
    // }

    // TODO: it is possible it doesn't have a timestamp at all if we missed it from mempool
    if (!ctx.block_hash) {
      result.timestamp =
        ctx.block_time || Math.floor(new Date().getTime() / 1000)
    }
  } catch (e) {
    console.error('Failed to bob tx', e)
    return null
  }

  // If this has an AIP or Sigma signature, look it up on the BAP API
  // and add a record to the "_signers" collection
  // _signers: [{
  //   address: "1a...",
  //   bapID: "1a...",
  //   lastMessage: {
  //     content: "Hello world",
  //     context: "channel",
  //     contextValue: "test",
  //     timestamp: 1234567890,
  //     context: undefined,
  //     txid: "a1...",
  //   },
  //   lastPost: {
  //     content: "Hello world",
  //     context: "url",
  //     contextValue: "http://google.com",
  //     timestamp: 1234567890,
  //     txid: "a1...",
  //   },
  //   profile: {
  //     ...
  //   }
  // }]

  // TODO when new blocks come in look for signers and update cache
  if (result.AIP && result.AIP.length) {
    // Map over each AIP entry to handle asynchronously
    const bapPromises = result.AIP.map(async (aip) => {
      // Try to get the BAP ID from cache first
      const cachedBap = await readFromRedis(`signer-${aip.address}`)
      // Check if the cached value is an error with 404 status
      if (cachedBap && 'error' in cachedBap && cachedBap.error === 404) {
        console.log('BAP not found in cache, fetching:', aip.address)
        // Fetch the BAP ID as it's not in the cache
        const bap = await getBAPIdByAddress(aip.address)
        if (bap) {
          // Cache the newly fetched BAP ID
          await saveToRedis(`signer-${aip.address}`, {
            type: 'signer',
            value: bap,
          })
          console.log('BAP saved to cache:', bap)
        } else {
          console.log('No BAP found for address:', aip.address)
        }
      } else if (cachedBap) {
        // BAP ID was found in cache, no need to fetch
        console.log('BAP already in cache for address:', aip.address)
      }
      // No need to return anything as this is just for side-effects (caching)
    })

    // Execute all promises in parallel
    await Promise.all(bapPromises)
  }

  try {
    return await saveTx(result as BobTx)
  } catch (e) {
    console.error('Failed to save tx', e)
    return null
  }
}
