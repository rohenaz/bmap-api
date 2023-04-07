import {
  ControlMessageStatusCode,
  JungleBusClient,
  Transaction,
} from '@gorillapool/js-junglebus'
import { BmapTx, BobTx } from 'bmapjs/types/common.js'
import { parse } from 'bpu-ts'
import chalk from 'chalk'
import { rewind, saveTx } from './actions.js'
import { getDbo } from './db.js'

let currentBlock = 0
let synced = false

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

const crawl = (height: number, jungleBusClient: JungleBusClient) => {
  return new Promise(async (resolve, reject) => {
    // only block indexes greater than given height

    // create subscriptions in the dashboard of the JungleBus website
    const subId =
      //'3f600280c71978452b73bc7d339a726658e4b4dd5e06a50bd81f6d6ddd85abe9'
      // '6aa5f8d340fe8761bb60f993113f238a2e1c63eceecb13a4a438b7dff2e26261'
      // '8229be3168fbc1d0955086ba43cb9e0c12bf423615df57630029af9ff61565b9'
      '267c23b9b9f105a4a0ee1ec50170ad904e4724e14dee85d8a878d083af638b5d'
    await jungleBusClient.Subscribe(
      subId,
      height,
      async function onPublish(ctx) {
        //console.log('TRANSACTION', ctx.id)
        try {
          await processTransaction(ctx)
        } catch (e) {
          console.log(chalk.redBright(`Failed to process block tx`, e))
        }
      },
      async function onStatus(cMsg) {
        if (cMsg.statusCode === ControlMessageStatusCode.BLOCK_DONE) {
          // add your own code here

          setCurrentBlock(cMsg.block)

          console.log(
            chalk.blue('####  '),
            chalk.magenta('NEW BLOCK '),
            chalk.green(currentBlock),
            cMsg.transactions > 0
              ? chalk.bgCyan(cMsg.transactions)
              : chalk.bgGray('No transactions this block')
          )
        } else if (cMsg.statusCode === ControlMessageStatusCode.WAITING) {
          console.log(
            chalk.blue('####  '),
            chalk.yellow('WAITING ON NEW BLOCK ')
          )
          synced = true
        } else if (cMsg.statusCode === ControlMessageStatusCode.REORG) {
          console.log(
            chalk.blue('####  '),
            chalk.red('REORG TRIGGERED ', cMsg.block)
          )

          await rewind(cMsg.block)
          setCurrentBlock(cMsg.block)
        } else {
          chalk.red(cMsg)
        }
      },
      function onError(cErr) {
        console.error(cErr)
        reject(cErr)
      },
      async function onMempool(ctx) {
        console.log('MEMPOOL TRANSACTION', ctx.id)

        try {
          await processTransaction(ctx)
        } catch (e) {
          console.log(chalk.redBright(`Failed to process mempool tx`, e))
        }
      }
    )
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

const crawler = async (jungleBusClient: JungleBusClient) => {
  await getDbo() // warm up db connection

  chalk.cyan('CRAWLING FROM BLOCK HEIGH', currentBlock)

  await crawl(currentBlock, jungleBusClient).catch((e) => {
    // do something with error
    console.log('ERROR', e)
  })
}

const setCurrentBlock = (num: number) => {
  currentBlock = num
}

export { setCurrentBlock, synced, crawler }
