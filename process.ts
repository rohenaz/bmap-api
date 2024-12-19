import type { Transaction } from '@gorillapool/js-junglebus'
import type { BmapTx, BobTx } from 'bmapjs'
import { parse } from 'bpu-ts'
import { saveTx } from './actions.js'
import { resolveSigners } from './bap.js'
import { addToCache, checkCache } from './cache.js'

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

    const txid = result.tx.h
    if (await checkCache(txid)) {
      console.log('Already processed:', txid)
      return
    }

    await addToCache(txid)

    if (!ctx.block_hash) {
      result.timestamp =
        ctx.block_time || Math.floor(new Date().getTime() / 1000)
    }
  } catch (e) {
    console.error('Failed to bob tx', e)
    return null
  }

  if (result?.AIP?.length > 0) {
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
