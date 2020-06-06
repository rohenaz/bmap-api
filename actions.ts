import { TransformTx, BmapTx } from 'bmapjs'
import * as chalk from 'chalk'
import { getDbo, closeDb } from './db'

const saveTx = async (tx) => {
  let t
  // Transform
  try {
    let dbo = await getDbo()
    t = await TransformTx(tx)

    if (t) {
      let collection = t.blk ? 'c' : 'u'
      await dbo.collection(collection).insertOne(t)

      console.log(
        collection === 'u'
          ? (chalk.green('saved'), chalk.magenta('unconfirmed'))
          : '',
        (chalk.cyan('saved'), chalk.green(t.tx.h))
      )
      await closeDb()
      return t
    } else {
      await closeDb()
      throw new Error('Invalid tx')
    }
  } catch (e) {
    await closeDb()
    let txid = tx && tx.tx ? tx.tx.h : undefined
    throw new Error('Failed to save ' + txid + ' : ' + e)
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
