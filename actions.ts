import bmapjs from 'bmapjs'
import { BobTx } from 'bmapjs/types/common'
import chalk from 'chalk'
import _ from 'lodash'
import { Db } from 'mongodb'
import { getDbo } from './db.js'
const { TransformTx } = bmapjs
const { head } = _
const bapCache = new Map<string, Object>()
const bapApiUrl = `https://bap-api.com/v1/`

export const saveTx = async (tx: BobTx) => {
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
    // normalize B content field with the go library
    if (t.B) {
      for (let i = 0; i < t.B.length; i++) {
        t.B[i].Data = { utf8: t.B[i].content }
        delete t.B[i].content
      }
      delete t.B.content
    }
    let mapType = head(t.MAP)['type'] as string
    // let collection = t.blk ? 'c' : 'u'
    let collection = mapType
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

const getBAPIdByAddress = async (
  address: string,
  block?: number,
  timestamp?: number
) => {
  try {
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

    return false
  } catch (e) {
    console.log(chalk.redBright(e))
    throw e
  }
}

export const saveSigners = async (tx: BobTx) => {
  // save AIP signers
  if (tx.AIP) {
    let bap
    // multiple AIP outputs
    for (let aip of tx.AIP) {
      const { address } = aip
      try {
        bap = await getBAPIdByAddress(
          address,
          tx.blk.i || undefined,
          tx.timestamp
        )
      } catch (e) {
        console.log(chalk.redBright('Failed to get BAP ID by Address', e))
      }
    }
  }

  // save Sigma signers
  if (tx.SIGMA) {
  }
}
