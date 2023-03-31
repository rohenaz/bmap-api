import bmapjs from 'bmapjs'
import { BobTx } from 'bmapjs/types/common.js'
import chalk from 'chalk'
import { Db } from 'mongodb'
import { getDbo } from './db.js'
const { TransformTx } = bmapjs
const bapCache = new Map<string, Object>()

const saveTx = async (tx: BobTx) => {
  let t: any
  let dbo: Db
  // Transform
  try {
    dbo = await getDbo()
  } catch (e) {
    // await closeDb()
    let txid = tx && tx.tx ? tx.tx.h : undefined
    throw new Error('Failed to get dbo ' + txid + ' : ' + e)
  }
  try {
    t = await TransformTx(tx)
  } catch (e) {
    throw new Error('Failed to transform tx ' + tx)
  }

  // get BAP IDs for given social op
  if (t.AIP) {
    let bap
    // multiple AIP outputs
    if (Array.isArray(t.AIP)) {
      for (let i = 0; i < t.AIP.length; i++) {
        const { address } = t.AIP[i]
        try {
          bap = await getBAPIdByAddress(
            address,
            t.blk.i || undefined,
            t.timestamp
          )
          //TODO: add && bap.valid === true when BAP API returns this correctly
          if (bap) {
            t.AIP[i].bapId = bap.idKey
            if (bap.identity) {
              t.AIP[i].identity = JSON.parse(bap.identity)
            }
          }
        } catch (e) {
          console.log(chalk.redBright('Failed to get BAP ID by Address', e))
        }
      }
    } else {
      console.log(chalk.redBright('Unexpected AIP object format'))
    }
  }

  if (t) {
    let collection = t.blk ? 'c' : 'u'
    let txId = tx && tx.tx ? tx.tx.h : undefined
    t._id = txId
    try {
      let timestamp = t.timestamp as number
      delete t.timestamp

      // sending a ping will makesure we're connecting before trying to insert
      // if it fails we enter the catch
      // failing on updateOne on the other hand will crash
      await dbo.command({ ping: 1 })

      await dbo.collection(collection).updateOne(
        { _id: t._id },
        {
          $set: t,
          $setOnInsert: {
            timestamp: timestamp || Math.round(new Date().getTime() / 1000),
          },
        },
        {
          upsert: true,
        }
      )
      return t
    } catch (e) {
      console.log('not inserted', e)
      console.log(
        collection === 'u'
          ? (chalk.green('saved'), chalk.magenta('unconfirmed'))
          : '',
        (chalk.cyan('saved'), chalk.green(t.tx.h))
      )

      throw new Error('Failed to insert tx ' + txId + ' : ' + e)
    }
  } else {
    throw new Error('Invalid tx')
  }
}

const rewind = async (block: number) => {
  let dbo = await getDbo()

  await dbo.collection('c').deleteMany({ 'blk.i': { $gt: block } })
  await clearUnconfirmed()
}

const clearUnconfirmed = () => {
  return new Promise<void>(async (res, rej) => {
    let dbo = await getDbo()
    dbo
      .listCollections({ name: 'u' })
      .toArray(async function (err: any, collections: any[]) {
        if (
          collections
            .map((c) => {
              return c.name
            })
            .indexOf('u') !== -1
        ) {
          try {
            // ToDo - This can throw errors during sync
            await dbo.collection('u').drop(async function (err, delOK) {
              if (err) {
                // await closeDb()
                rej(err)
                return
              }
              if (delOK) res()
            })
            // await closeDb()
            res()
          } catch (e) {
            // await closeDb()
            rej(e)
          }
        }
      })
  })
}

export { saveTx, clearUnconfirmed, rewind }

const bapApiUrl = `https://bap-api.com/v1`
const getBAPIdByAddress = async (address, block, timestamp) => {
  if (bapApiUrl) {
    if (bapCache.has(address)) {
      // return BAP ID from cache
      // TODO: This should be a seprate collection
      return bapCache.get(address)
    }
    try {
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

      bapCache.set(address, data)
      if (data && data.status === 'OK' && data.result) {
        return data.result
      }
    } catch (e) {
      console.log(chalk.redBright(e))
      throw e
    }
  }

  return false
}
