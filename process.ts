import type { Transaction } from '@gorillapool/js-junglebus'
import type { BmapTx, BobTx } from 'bmapjs'
import { parse } from 'bpu-ts'
import { saveTx } from './actions.js'
import { resolveSigners } from './bap.js'
import { cacheIngestedTxid, wasIngested } from './cache.js'

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

export async function processTransaction(
  ctx: Partial<Transaction>
): Promise<BmapTx> {
  let result: Partial<BmapTx>

  try {
    result = (await bobFromRawTx(ctx.transaction)) as Partial<BmapTx>

    result.blk = {
      i: ctx.block_height || 0,
      t: ctx.block_time || Math.round(new Date().getTime() / 1000),
    }

    const ingested = await wasIngested(ctx.id)
    if (ingested) {
      console.log('Already ingested', ctx.id)
      return
    }
    await cacheIngestedTxid(result.tx.h)
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
  if (result?.AIP?.length > 0) {
    // Map over each AIP entry to handle asynchronously
    try {
      await resolveSigners([result as BmapTx])
    } catch (e) {
      console.error('Failed to resolve signers', e)
    }
  }

  try {
    return await saveTx(result as BobTx)
  } catch (e) {
    console.error('Failed to save tx', e)
    return null
  }
}
