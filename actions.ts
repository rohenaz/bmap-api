import { TransformTx } from 'bmapjs'
import * as chalk from 'chalk'
import { closeDb, getDbo } from './db'

const saveTx = async (tx) => {
  let t
  // Transform
  try {
    let dbo = await getDbo()
    try {
      t = await TransformTx(tx)
      if (t) {
        let collection = t.blk ? 'c' : 'u'
        try {
          await dbo.collection(collection).insertOne(t)
          await closeDb()
          return t
        } catch (e) {
          console.log(
            collection === 'u'
              ? (chalk.green('saved'), chalk.magenta('unconfirmed'))
              : '',
            (chalk.cyan('saved'), chalk.green(t.tx.h))
          )
          await closeDb()

          let txid = tx && tx.tx ? tx.tx.h : undefined
          throw new Error('Failed to get dbo ' + txid + ' : ' + e)
        }
      } else {
        await closeDb()
        throw new Error('Invalid tx')
      }
    } catch (e) {
      await closeDb()
      throw new Error('Failed to transform tx ' + tx)
    }
  } catch (e) {
    await closeDb()
    let txid = tx && tx.tx ? tx.tx.h : undefined
    throw new Error('Failed to get dbo ' + txid + ' : ' + e)
  }
}

const clearUnconfirmed = () => {
  return new Promise(async (res, rej) => {
    let dbo = await getDbo()
    dbo
      .listCollections({ name: 'u' })
      .toArray(async function (err, collections) {
        if (
          collections
            .map((c) => {
              return c.name
            })
            .indexOf('u') !== -1
        ) {
          try {
            // ToDo - This can throw errors during sync
            await dbo.collection('u').drop(function (err, delOK) {
              if (err) {
                closeDb()
                rej(err)
                return
              }
              if (delOK) res()
            })
            closeDb()
            res()
          } catch (e) {
            closeDb()
            rej(e)
          }
        }
      })
  })
}

export { saveTx, clearUnconfirmed }
