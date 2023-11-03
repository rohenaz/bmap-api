import { Transaction } from '@gorillapool/js-junglebus'
import { BmapTx, BobTx } from 'bmapjs/types/common'
import { parse } from 'bpu-ts'
import { saveTx } from './actions.js'
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

export async function processTransaction(ctx: Partial<Transaction>) {
  let result: Partial<BobTx>
  try {
    result = (await bobFromRawTx(ctx.transaction)) as Partial<BmapTx>

    result.blk = {
      i: ctx.block_height || 0,
      t: ctx.block_time || Math.round(new Date().getTime() / 1000),
    }
    if (wasIngested(result.tx.h)) {
      console.log('Already ingested', result.tx.h)
      return null
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
        ctx.block_time || Math.floor(new Date().getTime() / 1000 - 86400)
    }
  } catch (e) {
    console.error('Failed to bob tx', e)
    return null
  }

  try {
    return await saveTx(result as BobTx)
  } catch (e) {
    console.error('Failed to save tx', e)
    return null
  }
}
