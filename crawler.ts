import { saveTx } from './actions'
import * as chalk from 'chalk'
import { config } from './config'
import * as es from 'event-stream'
import fetch from 'node-fetch'
import { query } from './queries'
import { saveFiles } from './bitfs'

let currentBlock = 0
let synced = false

const crawl = (query, height) => {
  return new Promise(async (resolve, reject) => {
    // only block indexes greater than given height
    query.q.find['blk.i'] = { $gt: height }

    let res
    try {
      res = await fetch('https://bob.bitbus.network/block', {
        method: 'post',
        headers: {
          'Content-type': 'application/json; charset=utf-8',
          token: config.token,
        },
        body: JSON.stringify(query),
      })
    } catch (e) {
      console.error('Failed to reach bitbus', e)
      reject()
      return
    }

    // The promise is resolved when the stream ends.
    res.body
      .on('end', () => {
        resolve()
      })
      // Split NDJSON into an array stream
      .pipe(es.split())
      // Apply the logic for each line
      .pipe(
        es.mapSync(async (t) => {
          if (t) {
            let j
            try {
              j = JSON.parse(t)
            } catch (e) {
              // Invalid response
              console.error('Invalid response', e, t)
              return null
            }
            if (!j) {
              console.log('Invalid response', j)
              return
            }
            // New block
            if (j.blk && j.blk.i > currentBlock) {
              setCurrentBlock(j.blk.i)
              console.log(
                chalk.blue('####  '),
                chalk.magenta('NEW BLOCK '),
                chalk.green(currentBlock)
              )
              // planarium.send('socket', { type: 'block', block: currentBlock })
            }

            //             // Extract BitFS URIs
            //             // Iterate through all outputs and find chunks whose names start with "f"
            let bitfs = []
            if (j.out) {
              j.out.forEach((out) => {
                for (let tape of out.tape) {
                  let cell = tape.cell
                  for (let pushdata of cell) {
                    if (pushdata.hasOwnProperty('f')) {
                      bitfs.push(pushdata.f)
                    }
                  }
                }
              })
            }
            // Crawl BitFS
            saveFiles(bitfs)

            try {
              return await saveTx(j)
            } catch (e) {
              return null
            }
          }
        })
      )
  })
}

const crawler = (syncedCallback) => {
  crawl(query, currentBlock).then(() => {
    if (!synced) {
      console.log(chalk.green('BITBUS SYNC COMPLETE'))
      synced = true
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
