import { config } from './config.js'
import { getDbo } from './db.js'

const getCurrentBlock = (): Promise<number> => {
  return new Promise(async (resolve, reject) => {
    try {
      let dbo = await getDbo()
      dbo
        .collection('c')
        .find({ 'blk.i': { $gt: 0 } })
        .sort({ 'blk.i': -1 })
        .limit(1)
        .toArray(async function (err, result) {
          if (err) {
            console.error('Failed toArray', err)
            // await closeDb()
            reject(err)
          }

          if (result && result.length > 0) {
            // only clear unconfirmed when block is higher than last item from socket too latest_block
            // await closeDb()
            resolve(result[0].blk.i)
          } else {
            console.log('No existing records. Crawling from the beginning.')
            // await closeDb()
            resolve(config.from)
          }
        })
    } catch (e) {
      console.error('Failed to get current block', e)
      // await closeDb()
      reject(e)
    }
  })
}

export { getCurrentBlock }
