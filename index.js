const { planaria } = require('neonplanaria')
const MongoClient = require('mongodb')
const path = require('path')
const bmap = require('bmapjs')
const winston = require('winston')
let db

const logger = winston.createLogger({
  level: 'error',
  format: winston.format.json(),
  defaultMeta: { service: 'planaria' },
  transports: [
    //
    // - Write to all logs with level `info` and below to `combined.log` 
    // - Write all logs error (and below) to `error.log`.
    //
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
})

// Filter non BMAP txs. 
// Returns bmap versions of each tx
const bmapTransform = function (items) {
  let newItems = []

  items.forEach(async (item) => {
    try {
      let bmapItem = await bmap.TransformTx(item)
      if (!bmapItem) {
        logger.log({level: 'error', message: 'failed to transform this ' + bmapItem })
        return []
      }
      let hasMap = bmapItem.hasOwnProperty('MAP')
      // let hasB = bmapItem.hasOwnProperty('B')
      // let hasMeta = bmapItem.hasOwnProperty('METANET')
      if (bmapItem && hasMap) {
        logger.log({ level: 'info', message: 'Storing BMAP ' + bmapItem.tx.h })
        newItems.push(bmapItem)
      }
    } catch (e) {
      logger.log({
        level: 'error',
        message: 'tx: ' + item.tx.h + ' e: ' + e
      })    
    }
  })
  return newItems
}

const connect = function(cb) {
  MongoClient.connect('mongodb://localhost:27017', {useNewUrlParser: true}, function(err, client) {
    if (err) {
      logger.log({ level: 'info', message: 'DB Error. retrying...' })
      setTimeout(function() {
        connect(cb)
      }, 1000)
    } else {
      db = client.db("planaria")
      cb()
    }
  })
}
planaria.start({
  filter:  {
    "from": 585000,
    "host": {
      "bitbus": "https://bob.bitbus.network"
    },
    "q": {
      "find": { 
        "out.tape.cell.s": { 
          "$in": ["19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut", "1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5"] 
        }
      }
    }
  },
  onmempool: async function(e) {
    let bmaps = bmapTransform([e.tx])
    await db.collection("u").insertMany(bmaps)
  },
  onblock: async function(e) {
    await db.collection("u").deleteMany({ })

    let bmaps = bmapTransform(e.tx)
    try {
      await db.collection("c").insertMany(bmaps)
    } catch (err) {
      logger.log({ level: 'error', message: 'error saving on block: ' + err + 'items: ' + bmaps.length })      
    }

    if (e.mem.length) {
      let bmapsMem = bmapTransform(e.mem)
      await db.collection("u").insertMany(bmapsMem)
    }
  },
  onstart: function(e) {
    if (process.env.NODE_ENV !== 'production') {
      logger.add(new winston.transports.Console({
        format: winston.format.simple()
      }))
    }
    return new Promise(async function(resolve, reject) {
      if (!e.tape.self.start) {
        await planaria.exec("docker", ["pull", "mongo:latest"])
        await planaria.exec("docker", ["run", "-d", "-p", "27017-27019:27017-27019", "-v", process.cwd() + (process.platform === 'win32' ? "/db" : "/db:/data/db"), "mongo:latest"])
      }
      connect(function() {
        logger.log({ level: 'info', message: 'Connected' })
        if (e.tape.self.start) {
          db.collection("c").deleteMany({
            "blk.i": { "$gt": e.tape.self.end }
          }).then(resolve)
        } else {
          resolve()
        }
      })
    })
  },
})