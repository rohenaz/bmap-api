import { JungleBusClient } from '@gorillapool/js-junglebus'
import BPU from 'bpu'
import chalk from 'chalk'
import { saveTx } from './actions.js'
import { closeDb } from './db.js'
import { query } from './queries.js'

let currentBlock = 0
let synced = false

const crawl = (query, height) => {
  return new Promise(async (resolve, reject) => {
    // only block indexes greater than given height
    const server = "junglebus.gorillapool.io";
    console.log('CRAWLING', server)
    const jungleBusClient = new JungleBusClient(server, {
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
    jungleBusClient.Login(process.env.JUNGLEBUS_USERNAME, process.env.JUNGLEBUS_PASS);
    jungleBusClient.Connect();

    // create subscriptions in the dashboard of the JungleBus website
    const subId = "3f600280c71978452b73bc7d339a726658e4b4dd5e06a50bd81f6d6ddd85abe9";

    const subscription = jungleBusClient.Subscribe(
      subId,
      height, 
      async function onPublish(ctx) {
        // transaction found
        console.log({ctx});

        try {
          let result = await BPU.parse({
            tx: { r: ctx.transaction }
          })

          result.blk.i = ctx.block_height
          result.blk.t = ctx.block_time
          result.blk.m = ctx.merkle_proof
          result.blk.h = ctx.block_hash
          return await saveTx(result)
        } catch (e) {
          return null
        }
      },
      function onBlockDone(cMsg) {
        // add your own code here
        setCurrentBlock(cMsg.block_height)
        console.log(
          chalk.blue('####  '),
          chalk.magenta('NEW BLOCK '),
          chalk.green(currentBlock)
        )
        // planarium.send('socket', { type: 'block', block: currentBlock })
        console.log({cMsg});
      });
      
    subscription.Subscribe();

    // // only block indexes greater than given height
    // query.q.find['blk.i'] = { $gt: height }

    // let res
    // try {
    //   res = await fetch('https://bob.bitbus.network/block', {
    //     method: 'post',
    //     headers: {
    //       'Content-type': 'application/json; charset=utf-8',
    //       token: config.token,
    //     },
    //     body: JSON.stringify(query),
    //   })
    // } catch (e) {
    //   console.error('Failed to reach bitbus', e)
    //   reject()
    //   return
    // }

    // // The promise is resolved when the stream ends.
    // res.body
    //   .on('end', () => {
    //     resolve()
    //   })
    //   // Split NDJSON into an array stream
    //   .pipe(es.split())
    //   // Apply the logic for each line
    //   .pipe(
    //     es.mapSync(async (t) => {
    //       if (t) {
    //         let j
    //         try {
    //           j = JSON.parse(t)
    //         } catch (e) {
    //           // Invalid response
    //           console.error('Invalid response', e, t)
    //           return null
    //         }
    //         if (!j) {
    //           console.log('Invalid response', j)
    //           return
    //         }
    //         // New block
    //         if (j.blk && j.blk.i > currentBlock) {
    //           setCurrentBlock(j.blk.i)
    //           console.log(
    //             chalk.blue('####  '),
    //             chalk.magenta('NEW BLOCK '),
    //             chalk.green(currentBlock)
    //           )
    //           // planarium.send('socket', { type: 'block', block: currentBlock })
    //         }

    //         //             // Extract BitFS URIs
    //         //             // Iterate through all outputs and find chunks whose names start with "f"
    //         let bitfs = []
    //         if (j.out) {
    //           j.out.forEach((out) => {
    //             for (let tape of out.tape) {
    //               let cell = tape.cell
    //               for (let pushdata of cell) {
    //                 if (pushdata.hasOwnProperty('f')) {
    //                   bitfs.push(pushdata.f)
    //                 }
    //               }
    //             }
    //           })
    //         }
    //         // Crawl BitFS
    //         saveFiles(bitfs)

    //         try {
    //           return await saveTx(j)
    //         } catch (e) {
    //           return null
    //         }
    //       }
    //     })
    //   )
  })
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

