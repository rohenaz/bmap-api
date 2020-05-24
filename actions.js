const bmap = require('bmapjs')
const chalk = require('chalk')

const saveTx = async (tx, collection, dbo) => {
  let t
  // Transform
  try {
    t = await bmap.TransformTx(tx)
  } catch (e) {
    throw new Error('Failed to transform', e, t)
  }

  if (t) {
    try {
      await dbo.collection(collection).insertOne(t)
    } catch (e) {
      console.error('Sonofabitch', e)
    }

    console.log(
      collection === 'u'
        ? (chalk.green('saved'), chalk.magenta('unconfirmed'))
        : '',
      (chalk.cyan('saved'), chalk.green(t.tx.h))
    )
    return t
  } else {
    throw new Error('Invalid tx')
  }
}

const clearUnconfirmed = (dbo) => {
  return new Promise((res, rej) => {
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
              if (err) rej(err)
              if (delOK) res()
            })
            res()
          } catch (e) {
            rej(e)
          }
        }
      })
  })
}

exports.saveTx = saveTx
exports.clearUnconfirmed = clearUnconfirmed
