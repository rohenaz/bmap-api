import { JungleBusClient, Transaction } from '@gorillapool/js-junglebus'
import BPU from 'bpu'
import chalk from 'chalk'
import { saveTx } from './actions.js'
import { closeDb } from './db.js'
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

const crawl = (query, height) => {
  return new Promise(async (resolve, reject) => {
    // only block indexes greater than given height
    const server = "junglebus.gorillapool.io";
    console.log('CRAWLING', server)
    const jungleBusClient = new JungleBusClient(server, {
      debug: true,
      protocol: "protobuf",
      onConnected(ctx) {
        // add your own code here
        console.log(ctx);
      },
      onConnecting(ctx) {
        // add your own code here
        console.log(ctx);
      },
      onDisconnected(ctx) {
        // add your own code here
        console.log(ctx);
      },
      onError(ctx) {
        // add your own code here
        console.error(ctx);
      }
    });
    // create subscriptions in the dashboard of the JungleBus website
    const subId = "3f600280c71978452b73bc7d339a726658e4b4dd5e06a50bd81f6d6ddd85abe9";
    const subscription = await jungleBusClient.Subscribe(
      subId,
      currentBlock || height,
      async function onPublish(ctx) {
        //console.log('TRANSACTION', ctx.id)
        return await processTransaction(ctx);
      },
      function onBlockDone(cMsg) {

        // add your own code here
        setCurrentBlock(cMsg.block)
        console.log(
          chalk.blue('####  '),
          chalk.magenta('NEW BLOCK '),
          chalk.green(currentBlock)
        )
        // planarium.send('socket', { type: 'block', block: currentBlock })
        // console.log({cMsg});
      },
      function onError(cErr) {
        console.error(cErr)
      },
      async function onMempool(ctx) {
        //console.log('MEMPOOL TRANSACTION', ctx.id)
        return await processTransaction(ctx);
      },
      function onReorg(fromBlock) {
        console.error("REORG from block", fromBlock)
      });

    subscription.Subscribe();
  })
}

async function processTransaction(ctx: Transaction) {
  // transaction found
  // console.log({ctx});

  try {
    let result = await bobFromRawTx(ctx.transaction);
    if (!result.blk) {
      result.blk = {};
    }

    if (ctx.block_hash) {
      result.blk.i = ctx.block_height;
      result.blk.t = ctx.block_time;
      result.blk.m = ctx.merkle_proof;
      result.blk.h = ctx.block_hash;
    }

    return await saveTx(result);
  } catch (e) {
    console.error('Failed to save tx', e);
    return null;
  }
}

const crawler = (syncedCallback) => {
  crawl(query, currentBlock).then(() => {
    if (!synced) {
      console.log(chalk.green('JUNGLEBUS SYNC COMPLETE'))
      synced = true
      closeDb()
      syncedCallback()
    }

    setTimeout(() => {
      crawler(syncedCallback)
    }, 10000)
  })
}

const setCurrentBlock = (num) => {
  currentBlock = num
}

export { setCurrentBlock, synced, crawler }

