import { getDbo } from './db'

const getCurrentBlock = () => {
  return new Promise(async (resolve, reject) => {
    try {
      let dbo = await getDbo()
      dbo
        .collection('c')
        .find()
        .sort({ 'blk.i': -1 })
        .limit(1)
        .toArray(async function (err, result) {
          if (err) {
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
            resolve(0)
          }
        })
    } catch (e) {
      // await closeDb()
      reject(e)
    }
  })
}

export { getCurrentBlock }
