import {
  ControlMessageStatusCode,
  Transaction,
} from '@gorillapool/js-junglebus'
import BPU from 'bpu'
import chalk from 'chalk'
import { saveTx } from './actions.js'
import { getDbo } from './db.js'
import { query } from './queries.js'

let currentBlock = 0
let synced = false

const bobFromRawTx = async (rawtx) => {
  return await BPU.parse({
    tx: { r: rawtx },
    split: [
      {
        token: { op: 106 },
        include: 'l',
      },
      {
        token: { op: 0 },
        include: 'l',
      },
      {
        token: { s: '|' },
      },
    ],
  })
}

const crawl = (query, height, jungleBusClient) => {
  return new Promise(async (resolve, reject) => {
    // only block indexes greater than given height

    // create subscriptions in the dashboard of the JungleBus website
    const subId =
      '3f600280c71978452b73bc7d339a726658e4b4dd5e06a50bd81f6d6ddd85abe9'
    await jungleBusClient.Subscribe(
      subId,
      currentBlock || height,
      async function onPublish(ctx) {
        //console.log('TRANSACTION', ctx.id)
        return new Promise((resolve, reject) => {
          setTimeout(async () => {
            resolve(await processTransaction(ctx))
          }, 1000)
        })
      },
      function onStatus(cMsg) {
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
        } else if (cMsg.statusCode === ControlMessageStatusCode.REORG) {
          console.log(
            chalk.blue('####  '),
            chalk.red('REORG TRIGGERED ', cMsg.block)
          )
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

        return await processTransaction(ctx)
      }
    )
  })
}

async function processTransaction(ctx: Transaction) {
  let result: any
  try {
    result = await bobFromRawTx(ctx.transaction)
    result.blk = {
      i: ctx.block_height || 0,
      t: ctx.block_time,
      m: ctx.merkle_proof || '',
      h: ctx.block_hash || '',
    }

    // TODO: it is possible it doesn't have a timestamp at all if we missed it from mempool
    if (!ctx.block_hash) {
      result.timestamp = ctx.block_time
    }
  } catch (e) {
    console.error('Failed to bob tx', e)
    return null
  }

  // get BAP IDs for given social op
  if (result.AIP) {
    for (let i = 0; i < result.AIP.length; i++) {
      const { address } = result.AIP[i]
      const bap = await getBAPIdByAddress(
        address,
        result.blk.i,
        result.timestamp
      )
      if (bap && bap.valid === true) {
        result.AIP[i].bapId = bap.idKey
      }
    }
  }

  try {
    return await saveTx(result)
  } catch (e) {
    console.error('Failed to save tx', e)
    return null
  }
}

const crawler = async (jungleBusClient) => {
  await getDbo() // warm up db connection

  await crawl(query, currentBlock, jungleBusClient).catch((e) => {
    // do something with error
    console.log('ERROR', e)
  })
}

const setCurrentBlock = (num) => {
  currentBlock = num
}

export { setCurrentBlock, synced, crawler }

const bapApiUrl = `https://bap-api.com/v1`
const getBAPIdByAddress = async function (address, block, timestamp) {
  if (bapApiUrl) {
    const result = await fetch(`${bapApiUrl}/identity/validByAddress`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address,
        block,
        timestamp,
      }),
    })
    const data = await result.json()
    if (data && data.status === 'OK' && data.result) {
      return data.result
    }
  }

  return false
}
